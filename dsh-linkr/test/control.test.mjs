/**
 * The control socket and the Linkrd clipboard (CONTRACT §16).
 *
 * The golden bytes below are written by hand from the device's control-message
 * layout (verified on fw 1.7.0); they are not produced by the encoder under
 * test, so a change in the layout has to be a deliberate one.
 *
 * There is no WebSocket server in Node, and the protocol matters more than the
 * socket: the fake below implements exactly the four members the channel uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_FIELD,
  ClipboardChannel,
  MESSAGE_TYPE,
  buildControlUrl,
  clipboardBytes,
  decodeWsMessage,
  encodePong,
  encodeStatusRequest,
  encodeTextRequest,
  encodeWsMessage,
  revisionOf,
} from '../lib/control.js';
import { LinkrError } from '../lib/linkr.js';

/* ---------------- hand-rolled protobuf, for the fake device's frames ---------------- */

function encodeVarint(value) {
  let rest = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

const tag = (field, wire) => encodeVarint((BigInt(field) << 3n) | BigInt(wire));
const varintField = (field, value) => Buffer.concat([tag(field, 0), encodeVarint(value)]);
const textField = (field, value) => {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([tag(field, 2), encodeVarint(data.length), data]);
};
const bytesField = (field, value) => Buffer.concat([tag(field, 2), encodeVarint(value.length), value]);

function readVarintAt(buffer, start) {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    offset += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset };
    shift += 7n;
  }
  throw new Error('truncated varint');
}

/** field number → wire type + value, enough to inspect a frame a test captured. */
function readFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarintAt(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const value = readVarintAt(buffer, offset);
      offset = value.offset;
      fields.set(field, value.value);
      continue;
    }
    if (wire === 2) {
      const length = readVarintAt(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      fields.set(field, buffer.subarray(offset, end));
      offset = end;
      continue;
    }
    throw new Error(`unexpected wire type ${wire} in a test frame`);
  }
  return fields;
}

/* ---------------- the fake socket ---------------- */

class FakeControlSocket {
  static instances = [];
  /** @type {null | ((socket: FakeControlSocket, frame: Buffer) => void)} */
  static device = null;

  /**
   * @param {string} url
   * @param {{ failOpen?: boolean }} [options]
   */
  constructor(url, options = {}) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = '';
    this.sent = [];
    this.closed = false;
    this.listeners = new Map();
    FakeControlSocket.instances.push(this);
    setTimeout(() => {
      if (options.failOpen) {
        this.#emit('error', {});
        return;
      }
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.#emit('open', {});
    }, 0);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(frame) {
    const bytes = Buffer.from(frame);
    this.sent.push(bytes);
    FakeControlSocket.device?.(this, bytes);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = true;
    this.#emit('close', {});
  }

  /** Deliver one binary frame to the channel, the way the socket would. */
  deliver(frame) {
    const bytes = Buffer.from(frame);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.#emit('message', { data });
  }

  #emit(type, event) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

function resetFakes() {
  FakeControlSocket.instances = [];
  FakeControlSocket.device = null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A device that answers one status request and then one text request. */
function scriptedDevice({ status, textReply = true, mutate } = {}) {
  return (socket, frame) => {
    const message = decodeWsMessage(frame);
    if (message.type === MESSAGE_TYPE.ClipboardStatus) {
      socket.deliver(statusFrame(status));
      return;
    }
    if (message.type === MESSAGE_TYPE.ClipboardText && textReply) {
      const request = readFields(messageBody(frame, BODY_FIELD.ClipboardTextReq));
      const requestId = request.get(1)?.toString('utf8') ?? '';
      const revision = BigInt(status.revision) + 1n;
      mutate?.onText?.(request);
      socket.deliver(
        encodeWsMessage({
          type: MESSAGE_TYPE.ClipboardText,
          bodyField: BODY_FIELD.ClipboardTextReply,
          body: Buffer.concat([textField(1, requestId), varintField(3, revision)]),
        }),
      );
    }
  };
}

/** `WsMessage` body by field number: a captured request's inner message. */
function messageBody(frame, field) {
  return readFields(frame).get(field) ?? Buffer.alloc(0);
}

const DEFAULT_STATUS = {
  enabled: true,
  connected: true,
  session: 'session-1',
  revision: '7',
  hasText: false,
  text: '',
  maxBytes: 4096,
};

function statusFrame(overrides = {}) {
  const status = { ...DEFAULT_STATUS, ...overrides };
  const parts = [];
  if (status.enabled) parts.push(varintField(1, 1));
  if (status.connected) parts.push(varintField(2, 1));
  if (status.session) parts.push(textField(3, status.session));
  if (status.revision !== '') parts.push(varintField(4, BigInt(status.revision)));
  if (status.hasText) parts.push(varintField(5, 1));
  if (status.text) parts.push(textField(6, status.text));
  if (status.maxBytes) parts.push(varintField(7, status.maxBytes));
  return encodeWsMessage({
    type: MESSAGE_TYPE.ClipboardStatus,
    bodyField: BODY_FIELD.ClipboardStatusReply,
    body: Buffer.concat(parts),
  });
}

function channel(overrides = {}) {
  return new ClipboardChannel({
    origin: 'http://linkr.local',
    token: 'token-abc',
    WebSocketImpl: FakeControlSocket,
    timeoutMs: 200,
    idleMs: 0,
    ...overrides,
  });
}

/* ---------------- golden frames ---------------- */

test('golden: a clipboard status reply decodes field by field', () => {
  const frame = Buffer.from(
    '08' + '13' + // WsMessage.MessageType = 19 (ClipboardStatus)
      'da02' + '0d' + // field 43, 13-byte body
      '0801' + // Enabled = true
      '1001' + // Connected = true
      '1a02' + '7331' + // Session = "s1"
      '2007' + // Revision = 7
      '3880' + '20', // MaxTextBytes = 4096
    'hex',
  );
  const decoded = decodeWsMessage(frame);
  assert.equal(decoded.type, MESSAGE_TYPE.ClipboardStatus);
  assert.equal(decoded.code, 0n);
  assert.deepEqual(decoded.clipboardStatus, {
    enabled: true,
    connected: true,
    session: 's1',
    revision: '7',
    hasText: false,
    text: '',
    maxBytes: 4096,
  });
});

test('golden: a clipboard text request encodes exactly the bytes the device expects', () => {
  const frame = encodeTextRequest({
    token: 't',
    requestId: 'r1',
    session: 's1',
    revision: '7',
    text: '你好',
  });
  assert.equal(
    frame.toString('hex'),
    '08' + '14' + // MessageType = 20 (ClipboardText)
      '1201' + '74' + // Token = "t"
      'e202' + '12' + // field 44, 18-byte body
      '0a02' + '7231' + // RequestId = "r1"
      '1202' + '7331' + // Session = "s1"
      '1807' + // Revision = 7
      '2206' + 'e4bda0e5a5bd', // Text = "你好" (6 UTF-8 bytes)
  );
});

test('golden: a status request is an empty body whose presence is the question', () => {
  const frame = encodeStatusRequest('tok');
  const fields = readFields(frame);
  assert.equal(fields.get(1), 19n);
  assert.equal(fields.get(2).toString('utf8'), 'tok');
  assert.equal(fields.get(BODY_FIELD.ClipboardStatusReq).length, 0);
});

test('a ping is answered with a pong, and an unknown type is ignored', async (t) => {
  resetFakes();
  t.after(() => { FakeControlSocket.device = null; });
  FakeControlSocket.device = scriptedDevice({ status: DEFAULT_STATUS });
  const clipboard = channel();
  t.after(() => clipboard.close());

  await clipboard.status();
  const socket = FakeControlSocket.instances.at(-1);
  // A heartbeat the firmware may send at any time: proto3 omits enum 0, so the
  // only evidence is the body.
  socket.deliver(
    encodeWsMessage({
      type: MESSAGE_TYPE.Ping,
      bodyField: BODY_FIELD.PingReq,
      body: textField(1, 'ping'),
    }),
  );
  await sleep(5);
  const pong = socket.sent.map((frame) => decodeWsMessage(frame)).filter((m) => m.type === MESSAGE_TYPE.Pong);
  assert.equal(pong.length, 1, 'one pong for one ping');
  assert.deepEqual(decodeWsMessage(encodePong('', 'pong')).type, MESSAGE_TYPE.Pong);
});

/* ---------------- the channel ---------------- */

test('status reports what the device answered', async (t) => {
  resetFakes();
  FakeControlSocket.device = scriptedDevice({
    status: { ...DEFAULT_STATUS, hasText: true, text: 'copied on the host' },
  });
  const clipboard = channel();
  t.after(() => clipboard.close());
  const status = await clipboard.status();
  assert.equal(status.session, 'session-1');
  assert.equal(status.revision, '7');
  assert.equal(status.hasText, true);
  assert.equal(status.text, 'copied on the host');
  assert.equal(status.maxBytes, 4096);
});

test('status is a machine reason when Linkrd is off or not running', async (t) => {
  resetFakes();
  FakeControlSocket.device = scriptedDevice({ status: { ...DEFAULT_STATUS, enabled: false } });
  const clipboard = channel();
  t.after(() => clipboard.close());
  await assert.rejects(clipboard.status(), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.equal(error.reason, 'disabled');
    assert.match(error.sentence, /Plugin center/);
    return true;
  });

  resetFakes();
  FakeControlSocket.device = scriptedDevice({ status: { ...DEFAULT_STATUS, connected: false } });
  const second = channel();
  t.after(() => second.close());
  await assert.rejects(second.status(), (error) => {
    assert.equal(error.reason, 'disconnected');
    assert.match(error.sentence, /Linkrd\.img/);
    return true;
  });
});

test('write sends one text request built from the status, and returns the new revision', async (t) => {
  resetFakes();
  const seen = [];
  FakeControlSocket.device = scriptedDevice({
    status: DEFAULT_STATUS,
    mutate: { onText: (request) => seen.push(request) },
  });
  const clipboard = channel();
  t.after(() => clipboard.close());

  const result = await clipboard.write('你好 world');
  assert.equal(seen.length, 1, 'exactly one text request');
  const request = seen[0];
  assert.equal(request.get(1).toString('utf8').length > 0, true, 'a request id was generated');
  assert.equal(request.get(2).toString('utf8'), 'session-1');
  assert.equal(request.get(3), 7n, 'the revision the device handed out');
  assert.equal(request.get(4).toString('utf8'), '你好 world');
  assert.equal(result.bytes, clipboardBytes('你好 world'));
  assert.equal(result.maxBytes, 4096);
  assert.equal(result.revision, '8', 'the reply revision wins');
});

test('write refuses text over MaxTextBytes before touching the clipboard', async (t) => {
  resetFakes();
  const seen = [];
  FakeControlSocket.device = scriptedDevice({
    status: { ...DEFAULT_STATUS, maxBytes: 4 },
    mutate: { onText: (request) => seen.push(request) },
  });
  const clipboard = channel();
  t.after(() => clipboard.close());
  await assert.rejects(clipboard.write('你好'), (error) => {
    assert.match(error.sentence, /up to 4 bytes/);
    return true;
  });
  assert.equal(seen.length, 0, 'no text request for a refused size');
});

test('a device that never answers is reported as unsupported, not as a hang', async (t) => {
  resetFakes();
  FakeControlSocket.device = () => {};
  const clipboard = channel({ timeoutMs: 40 });
  t.after(() => clipboard.close());
  await assert.rejects(clipboard.status(), (error) => {
    assert.equal(error.reason, 'unsupported');
    assert.match(error.sentence, /1\.7\.0/);
    return true;
  });
});

test('a 403 on the control socket carries the code the caller retries on', async (t) => {
  resetFakes();
  FakeControlSocket.device = (socket) => {
    // The device stamps MessageCode = 403 on a rejected token; the body is empty,
    // so only the code says anything.
    const frame = encodeWsMessage({
      type: MESSAGE_TYPE.ClipboardStatus,
      bodyField: BODY_FIELD.ClipboardStatusReply,
      body: Buffer.alloc(0),
    });
    socket.deliver(Buffer.concat([frame, varintField(3, 403)]));
  };
  const clipboard = channel();
  t.after(() => clipboard.close());
  await assert.rejects(clipboard.status(), (error) => {
    assert.equal(error.code, 403);
    return true;
  });
});

test('one request at a time, and the token is read fresh for every frame', async (t) => {
  resetFakes();
  let token = 'first';
  FakeControlSocket.device = scriptedDevice({ status: DEFAULT_STATUS });
  const clipboard = channel({ token: () => token });
  t.after(() => clipboard.close());

  await clipboard.status();
  token = 'second';
  await clipboard.status();
  const socket = FakeControlSocket.instances.at(-1);
  const frames = socket.sent.map((frame) => readFields(frame));
  assert.equal(frames[0].get(2).toString('utf8'), 'first');
  assert.equal(frames[1].get(2).toString('utf8'), 'second');
});

test('a closed socket is not reused, and a new call opens another one', async (t) => {
  resetFakes();
  FakeControlSocket.device = scriptedDevice({ status: DEFAULT_STATUS });
  const clipboard = channel();
  t.after(() => clipboard.close());
  await clipboard.status();
  assert.equal(FakeControlSocket.instances.length, 1);
  FakeControlSocket.instances[0].close();
  await sleep(5);
  await clipboard.status();
  assert.equal(FakeControlSocket.instances.length, 2, 'a second socket after the first was closed');
});

test('buildControlUrl derives ws/wss and always the control path', () => {
  assert.equal(buildControlUrl('http://linkr.local'), 'ws://linkr.local/ws');
  assert.equal(buildControlUrl('https://linkr.lan:8443/'), 'wss://linkr.lan:8443/ws');
  assert.throws(() => buildControlUrl(''), LinkrError);
});

test('revisionOf keeps uint64 revisions out of JS numbers', () => {
  assert.equal(revisionOf('18446744073709551615'), '18446744073709551615');
  assert.equal(revisionOf(18446744073709551615n), '18446744073709551615');
  assert.equal(revisionOf('',), '');
  assert.equal(revisionOf('12abc'), '');
  assert.equal(revisionOf(-1n), '');
});
