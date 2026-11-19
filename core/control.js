/**
 * The device's control WebSocket, and the Linkrd clipboard behind it (CONTRACT §16).
 *
 * `ws/media` carries video and HID input; `/ws` carries the device's control
 * protobuf messages, and the firmware answers clipboard requests only there. One connection, one request in flight, no subprotocol:
 * the token rides in every message (`WsMessage.Token`), not in the handshake.
 *
 * Node built-ins only. The envelope is hand-rolled below because the clipboard
 * needs three message bodies, not a protobuf runtime.
 *
 * Protocol (observed on the device at fw 1.7.0; the field numbers are the wire
 * contract the firmware expects):
 *   WsMessage { 1 MessageType, 2 Token, 3 MessageCode int64, 4 Message,
 *               5 PingReq, 6 PongReply, 42 ClipboardStatusReq, 43 ClipboardStatusReply,
 *               44 ClipboardTextReq, 45 ClipboardTextReply }
 *   ClipboardStatusReply { 1 Enabled bool, 2 Connected bool, 3 Session string,
 *                          4 Revision uint64, 5 HasText bool, 6 Text string, 7 MaxTextBytes uint32 }
 *   ClipboardTextReq      { 1 RequestId string, 2 Session string, 3 Revision uint64, 4 Text string }
 *   ClipboardTextReply    { 1 RequestId string, 3 Revision uint64 }
 *
 * `Revision` is a uint64 the device uses as a monotonic clipboard version. It
 * must never pass through a JS Number: it arrives as a decimal string here and
 * is only compared as BigInt.
 */

import { randomUUID } from 'node:crypto';

import { LinkrError } from './linkr.js';

/** The control socket's path; no subprotocol, no query string. */
export const CONTROL_PATH = '/ws';

/** `WsMessage.MessageType` values this plugin sends. */
export const MESSAGE_TYPE = { Ping: 0, Pong: 888, ClipboardStatus: 19, ClipboardText: 20 };

/** `WsMessage` body field numbers. */
export const BODY_FIELD = {
  PingReq: 5,
  PongReply: 6,
  ClipboardStatusReq: 42,
  ClipboardStatusReply: 43,
  ClipboardTextReq: 44,
  ClipboardTextReply: 45,
};

/** How long one clipboard round trip may take. */
const DEFAULT_TIMEOUT_MS = 8000;
/** An idle control socket is closed rather than left open on the device. */
const DEFAULT_IDLE_MS = 60000;

/* ---------------- protobuf: just the wire types this needs ---------------- */

function encodeVarint(value) {
  let rest = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value) || 0));
  if (rest < 0n) throw new Error('negative varints are not used by this protocol');
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

function readVarint(buffer, start) {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset };
    shift += 7n;
    if (shift > 70n) throw new Error('varint is too long');
  }
  throw new Error('truncated varint');
}

/** A tiny protobuf writer: varint, length-delimited and nested messages. */
class Writer {
  #parts = [];

  #push(bytes) {
    this.#parts.push(Buffer.from(bytes));
    return this;
  }

  varintField(field, value) {
    this.#parts.push(encodeVarint((BigInt(field) << 3n) | 0n), encodeVarint(value));
    return this;
  }

  textField(field, value) {
    const data = Buffer.from(String(value ?? ''), 'utf8');
    this.#parts.push(encodeVarint((BigInt(field) << 3n) | 2n), encodeVarint(data.length), data);
    return this;
  }

  messageField(field, writer) {
    const data = writer.finish();
    this.#parts.push(encodeVarint((BigInt(field) << 3n) | 2n), encodeVarint(data.length), data);
    return this;
  }

  /** A length-delimited field whose body is already encoded (tests, hand-built frames). */
  rawMessageField(field, data) {
    const bytes = Buffer.from(data);
    this.#parts.push(encodeVarint((BigInt(field) << 3n) | 2n), encodeVarint(bytes.length), bytes);
    return this;
  }

  finish() {
    return Buffer.concat(this.#parts);
  }
}

/** UTF-8 byte length, which is what the device's `MaxTextBytes` counts. */
export function clipboardBytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** A uint64 revision as a decimal string, or '' when the field is missing or absurd. */
export function revisionOf(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : '';
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '';
  try {
    return BigInt(text).toString();
  } catch {
    return '';
  }
}

/* ---------------- encoding ---------------- */

/** `{ type, token, bodyField, body }` → one binary `WsMessage`. */
export function encodeWsMessage({ type, token = '', bodyField = null, body = null } = {}) {
  const writer = new Writer();
  writer.varintField(1, type);
  writer.textField(2, token);
  if (bodyField !== null && Buffer.isBuffer(body)) {
    writer.rawMessageField(bodyField, body);
  } else if (bodyField !== null && bodySet(body)) {
    writer.messageField(bodyField, body);
  }
  return writer.finish();
}

function bodySet(body) {
  if (body === null || body === undefined) return false;
  if (Buffer.isBuffer(body)) return true;
  if (typeof body.finish === 'function') return true;
  return Object.keys(body).length > 0;
}

/** ClipboardStatusReq: the body is an empty message, so presence is the request. */
export function encodeStatusRequest(token = '') {
  return encodeWsMessage({
    type: MESSAGE_TYPE.ClipboardStatus,
    token,
    bodyField: BODY_FIELD.ClipboardStatusReq,
    body: new Writer(),
  });
}

/** ClipboardTextReq for one text and the status it was built from. */
export function encodeTextRequest({ token = '', requestId, session, revision, text }) {
  const body = new Writer();
  body.textField(1, requestId);
  body.textField(2, session);
  body.varintField(3, BigInt(revisionOf(revision) || '0'));
  body.textField(4, text);
  return encodeWsMessage({
    type: MESSAGE_TYPE.ClipboardText,
    token,
    bodyField: BODY_FIELD.ClipboardTextReq,
    body,
  });
}

/** A pong answer to the firmware's heartbeat, so the socket is not dropped. */
export function encodePong(token = '', msg = 'pong') {
  const body = new Writer();
  body.textField(1, msg);
  return encodeWsMessage({ type: MESSAGE_TYPE.Pong, token, bodyField: BODY_FIELD.PongReply, body });
}

/* ---------------- decoding ---------------- */

function readStringField(buffer, start, end) {
  return buffer.subarray(start, end).toString('utf8');
}

function decodeClipboardStatus(buffer) {
  const status = {
    enabled: false,
    connected: false,
    session: '',
    revision: '',
    hasText: false,
    text: '',
    maxBytes: 0,
  };
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      if (field === 1) status.enabled = value.value !== 0n;
      else if (field === 2) status.connected = value.value !== 0n;
      else if (field === 4) status.revision = value.value.toString();
      else if (field === 5) status.hasText = value.value !== 0n;
      else if (field === 7) status.maxBytes = Number(value.value);
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('truncated clipboard status');
      if (field === 3) status.session = readStringField(buffer, offset, end);
      else if (field === 6) status.text = readStringField(buffer, offset, end);
      offset = end;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return status;
}

function decodeClipboardText(buffer) {
  const reply = { requestId: '', revision: '' };
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      if (field === 3) reply.revision = value.value.toString();
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('truncated clipboard text');
      if (field === 1) reply.requestId = readStringField(buffer, offset, end);
      offset = end;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return reply;
}

function decodePing(buffer) {
  let msg = '';
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('truncated ping');
      if (field === 1) msg = readStringField(buffer, offset, end);
      offset = end;
      continue;
    }
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  return { msg };
}

/**
 * One binary frame → `{ type, code, message, clipboardStatus?, clipboardText?, ping? }`.
 * Unknown fields are skipped, so a firmware that adds bodies cannot break this.
 */
export function decodeWsMessage(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input instanceof ArrayBuffer ? new Uint8Array(input) : input ?? []);
  const out = { type: null, code: 0n, message: '', clipboardStatus: null, clipboardText: null, ping: null };
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      if (field === 1) out.type = Number(value.value);
      else if (field === 3) out.code = value.value;
      continue;
    }
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('truncated ws message');
      const slice = buffer.subarray(offset, end);
      if (field === 4) out.message = slice.toString('utf8');
      else if (field === BODY_FIELD.ClipboardStatusReply) out.clipboardStatus = decodeClipboardStatus(slice);
      else if (field === BODY_FIELD.ClipboardTextReply) out.clipboardText = decodeClipboardText(slice);
      else if (field === BODY_FIELD.PingReq) out.ping = decodePing(slice);
      offset = end;
      continue;
    }
    if (wire === 1) {
      offset += 8;
      continue;
    }
    if (wire === 5) {
      offset += 4;
      continue;
    }
    throw new Error(`unsupported wire type ${wire}`);
  }
  // `Ping` is enum value 0, so proto3 omits the field; presence of a ping body is
  // the only evidence a heartbeat arrived.
  if (out.type === null && out.ping !== null) out.type = MESSAGE_TYPE.Ping;
  return out;
}

/** `http(s)://host[:port]` + `/ws` → `ws(s):`/`wss(s):` URL. */
export function buildControlUrl(origin) {
  const text = String(origin ?? '').trim();
  if (!text) {
    throw new LinkrError('no device origin', {
      sentence: 'no device address configured: set baseUrl to http://<device-ip>',
    });
  }
  const url = new URL(text);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = CONTROL_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/* ---------------- the clipboard channel ---------------- */

function notEnabledError() {
  return new LinkrError('clipboard not enabled', {
    reason: 'disabled',
    sentence:
      'Linkrd is not enabled on the device: install and enable it in the device console → Plugin center, then mount Linkrd.img on the controlled machine',
  });
}

function notConnectedError() {
  return new LinkrError('clipboard not connected', {
    reason: 'disconnected',
    sentence:
      'Linkrd is enabled but no clipboard session is connected: mount the virtual disk Linkrd.img on the controlled machine and run the Linkrd program there',
  });
}

function timeoutError(timeoutMs) {
  return new LinkrError('clipboard request timed out', {
    reason: 'unsupported',
    sentence: `the device did not answer the clipboard request within ${timeoutMs} ms: Linkrd may be missing, or the firmware predates clipboard support (needs 1.7.0+)`,
  });
}

/**
 * One control socket, one clipboard request at a time.
 *
 * The token is read per message: a stale token costs one 403 and one re-login,
 * never a rebuilt channel. The socket closes itself after `idleMs` of silence so
 * the device does not hold a connection nobody is using.
 */
export class ClipboardChannel {
  #origin;
  #token;
  #WebSocket;
  #timeoutMs;
  #idleMs;
  #socket = null;
  #opening = null;
  #pending = null;
  #requesting = false;
  #idleTimer = null;
  #closed = false;

  /**
   * @param {{ origin: string, token: string | (() => string | Promise<string>),
   *           WebSocketImpl?: typeof WebSocket, timeoutMs?: number, idleMs?: number }} options
   */
  constructor(options = {}) {
    this.#origin = String(options.origin ?? '');
    this.#token = options.token ?? '';
    this.#WebSocket = options.WebSocketImpl ?? globalThis.WebSocket;
    this.#timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#idleMs = Number.isFinite(options.idleMs) && options.idleMs >= 0 ? options.idleMs : DEFAULT_IDLE_MS;
  }

  /** True while a control socket is open. */
  get open() {
    return this.#socket !== null && this.#socket.readyState === 1;
  }

  /** One `ClipboardStatusReq` → `{ enabled, connected, session, revision, hasText, text, maxBytes }`. */
  async status() {
    const reply = await this.#request({
      label: 'clipboard status',
      build: (token) => encodeStatusRequest(token),
      expect: (decoded) => (decoded.clipboardStatus ? { kind: 'status', ...decoded.clipboardStatus } : null),
    });
    if (!reply.enabled) throw notEnabledError();
    if (!reply.connected || !reply.session) throw notConnectedError();
    if (!reply.revision) {
      throw new LinkrError('clipboard status without revision', {
        sentence: 'the device answered the clipboard status without a revision: this firmware cannot sync the clipboard',
      });
    }
    return reply;
  }

  /**
   * Put `text` on the controlled machine's clipboard.
   *
   * The device wants the session and revision it handed out, so the write always
   * starts from a fresh status: a revision from before a reconnect would be
   * refused or, worse, applied to someone else's clipboard.
   *
   * @returns {Promise<{ revision: string, bytes: number, maxBytes: number }>}
   */
  async write(text) {
    const value = typeof text === 'string' ? text : '';
    const bytes = clipboardBytes(value);
    if (bytes === 0) {
      throw new LinkrError('nothing to write', { sentence: 'the clipboard text is empty' });
    }
    const status = await this.status();
    if (status.maxBytes > 0 && bytes > status.maxBytes) {
      throw new LinkrError('clipboard text too large', {
        sentence: `the device clipboard accepts up to ${status.maxBytes} bytes; this text is ${bytes} bytes`,
      });
    }
    const requestId = randomUUID();
    const reply = await this.#request({
      label: 'clipboard write',
      build: (token) =>
        encodeTextRequest({
          token,
          requestId,
          session: status.session,
          revision: status.revision,
          text: value,
        }),
      expect: (decoded) => {
        const body = decoded.clipboardText;
        if (!body || body.requestId !== requestId) return null;
        return { kind: 'text', ...body };
      },
    });
    const previous = BigInt(status.revision);
    const next = reply.revision && BigInt(reply.revision) >= previous ? reply.revision : status.revision;
    return { revision: next, bytes, maxBytes: status.maxBytes };
  }

  /** Read the controlled machine's clipboard as text (empty string when it has none). */
  async read() {
    const status = await this.status();
    return { text: status.hasText ? status.text : '', bytes: clipboardBytes(status.hasText ? status.text : ''), maxBytes: status.maxBytes };
  }

  async close() {
    this.#closed = true;
    this.#clearIdle();
    this.#failPending(new LinkrError('clipboard channel closed', { sentence: 'the clipboard channel was closed' }));
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  /* -- internals -- */

  async #request({ label, build, expect }) {
    if (this.#closed) {
      throw new LinkrError('clipboard channel closed', { sentence: 'the clipboard channel was closed; call again to reopen it' });
    }
    // Two callers can otherwise both pass the #pending check while the first is
    // still awaiting the socket/token; the device answers one frame at a time,
    // so only one request may be in the channel at all.
    if (this.#requesting || this.#pending) {
      throw new LinkrError('clipboard busy', { sentence: 'another clipboard request is still in flight; wait for it to finish' });
    }
    this.#requesting = true;
    try {
      const socket = await this.#ensureSocket();
      const token = await this.#currentToken();
      const frame = build(token);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending = null;
          // A socket that stopped answering is not worth keeping.
          this.#dropSocket();
          reject(timeoutError(this.#timeoutMs));
        }, this.#timeoutMs);
        this.#pending = {
          label,
          expect,
          resolve: (value) => {
            clearTimeout(timer);
            this.#pending = null;
            this.#touchIdle();
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            this.#pending = null;
            reject(error);
          },
        };
        try {
          socket.send(frame);
        } catch (error) {
          this.#pending = null;
          clearTimeout(timer);
          reject(
            new LinkrError('clipboard send failed', {
              sentence: 'the control socket refused the clipboard request',
              cause: error,
            }),
          );
        }
      });
    } finally {
      this.#requesting = false;
    }
  }

  async #currentToken() {
    const value = typeof this.#token === 'function' ? await this.#token() : this.#token;
    return String(value ?? '');
  }

  async #ensureSocket() {
    if (this.#socket && this.#socket.readyState === 1) return this.#socket;
    if (this.#opening) return this.#opening;
    this.#opening = this.#openSocket().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #openSocket() {
    const WS = this.#WebSocket;
    if (typeof WS !== 'function') {
      throw new LinkrError('no WebSocket global', {
        sentence: 'this Node runtime has no global WebSocket (needs Node 22+); the clipboard channel cannot open',
      });
    }
    const url = buildControlUrl(this.#origin);
    const socket = new WS(url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;

    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new LinkrError('control socket timeout', {
            sentence: `the device's control socket did not open within ${this.#timeoutMs} ms`,
          }),
        );
      }, this.#timeoutMs);
      const done = (fn) => (event) => {
        clearTimeout(timer);
        fn(event);
      };
      socket.addEventListener(
        'open',
        done(() => resolve()),
        { once: true },
      );
      socket.addEventListener(
        'error',
        done(() =>
          reject(
            new LinkrError('control socket error', {
              sentence:
                'the device refused its control socket: check that the device is reachable and that this plugin is allowed to reach it',
            }),
          ),
        ),
        { once: true },
      );
    });

    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', () => this.#onClose());

    try {
      await opened;
    } catch (error) {
      this.#dropSocket();
      throw error instanceof LinkrError ? error : new LinkrError('control socket failed', { cause: error });
    }
    this.#touchIdle();
    return socket;
  }

  #onMessage(event) {
    let decoded;
    try {
      decoded = decodeWsMessage(event.data);
    } catch {
      // A frame this build does not understand is not fatal: the control socket
      // also carries Wi-Fi, OTA and plugin traffic nobody here asked for.
      return;
    }
    if (decoded.type === MESSAGE_TYPE.Ping) {
      // Answering keeps the firmware from treating the socket as dead.
      try {
        this.#socket?.send(encodePong('', decoded.ping?.msg ?? 'pong'));
      } catch {
        // a failed pong just means no heartbeat
      }
      return;
    }
    if (decoded.type === MESSAGE_TYPE.Pong) return;
    const pending = this.#pending;
    if (!pending) return;
    let matched = null;
    try {
      matched = pending.expect(decoded);
    } catch {
      matched = null;
    }
    if (!matched) return;
    if (decoded.code !== 0n) {
      const code = decoded.code.toString();
      const detail = decoded.message ? `: ${decoded.message}` : '';
      if (code === '403') {
        // The token expired under us; the caller re-logs in and retries once.
        // Settle the request first: closing the socket emits `close`, and a
        // pending request must not be answered by the close handler instead.
        pending.reject(
          new LinkrError('control socket unauthorized', {
            sentence: 'the device rejected the control-socket token (403); log in again',
            code: 403,
            reason: 'device-error',
          }),
        );
        this.#dropSocket();
        return;
      }
      pending.reject(
        new LinkrError('clipboard request rejected', {
          reason: 'device-error',
          sentence: `the device rejected the ${pending.label} (code ${code})${detail}`,
          code: Number(code),
        }),
      );
      return;
    }
    pending.resolve(matched);
  }

  #onClose() {
    this.#socket = null;
    this.#failPending(
      new LinkrError('control socket closed', {
        sentence: 'the device closed its control socket',
      }),
    );
  }

  #failPending(error) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    pending.reject(error);
  }

  #dropSocket() {
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
  }

  #touchIdle() {
    this.#clearIdle();
    if (this.#idleMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.#dropSocket();
    }, this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle() {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}
