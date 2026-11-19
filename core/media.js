/**
 * One media socket: frames in, HID frames out (CONTRACT.md §1.4 and §7).
 *
 * Two source codecs, one API (`latest`/`waitFrame`/`onFrame`/`stats`):
 *
 *   mjpeg  POST /api/rtc/whep { offer: 'ws_mjpeg' }, device mode 1.
 *          Every binary message is one complete JPEG (FF D8 … FF D9).
 *   h264   POST /api/rtc/whep { offer: 'ws_h264' }, device mode 2.
 *          Every binary message is a 25-byte ws-media header + AnnexB payload;
 *          the payloads are piped into ONE ffmpeg child and its stdout is split
 *          on JPEG SOI/EOI into frames.
 *
 * Input rides the same socket for both codecs: `[type][protobuf]` (see hid.js).
 *
 * Node built-ins only: global WebSocket (Node >= 22), node:child_process for ffmpeg.
 */

import { LinkrError } from './linkr.js';
import { encodeKey, encodeMouse } from './hid.js';
import { spawnDecoder, clampJpegQuality, DEFAULT_JPEG_QUALITY } from './ffmpeg.js';

/** Subprotocol the device insists on. */
export const MEDIA_SUBPROTOCOL = 'ws-media';

/* ------------------------------------------------------------ ws-media packet */

/** Binary message header of the ws-media channel (CONTRACT.md §7.1). */
export const WS_MEDIA_HEADER_SIZE = 25;
export const WS_MEDIA_TYPE_VIDEO = 1;
export const WS_MEDIA_TYPE_AUDIO = 2;

const JPEG_SOI_BYTES = Buffer.from([0xff, 0xd8]);
const JPEG_EOI_BYTES = Buffer.from([0xff, 0xd9]);

function toBuffer(data) {
  if (data === undefined || data === null || typeof data === 'string') return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/**
 * Parse one ws-media message.
 *
 *   byte 0        uint8   mediaType (1 video, 2 audio)
 *   bytes 1..8    int64   ptsUs        big endian
 *   bytes 9..16   uint64  durationUs   big endian
 *   bytes 17..24  uint64  payloadSize  big endian, must be length - 25
 *   bytes 25..    payload
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{ mediaType: number, ptsUs: bigint, durationUs: bigint, payloadSize: bigint, payload: Buffer }}
 */
export function parseWsMediaPacket(bytes) {
  const buf = toBuffer(bytes);
  if (!buf) {
    throw new LinkrError('ws-media packet is not binary', {
      sentence: 'a ws-media packet must be binary, not text',
    });
  }
  if (buf.length < WS_MEDIA_HEADER_SIZE) {
    throw new LinkrError('ws-media packet too short', {
      sentence: `a ws-media packet is ${WS_MEDIA_HEADER_SIZE} header bytes plus a payload, got ${buf.length} bytes`,
    });
  }
  const mediaType = buf[0];
  if (mediaType !== WS_MEDIA_TYPE_VIDEO && mediaType !== WS_MEDIA_TYPE_AUDIO) {
    throw new LinkrError(`unknown ws-media type ${mediaType}`, {
      sentence: `unknown ws-media media type ${mediaType}: expected 1 (video) or 2 (audio)`,
    });
  }
  const payloadSize = buf.readBigUInt64BE(17);
  const actual = BigInt(buf.length - WS_MEDIA_HEADER_SIZE);
  if (payloadSize !== actual) {
    throw new LinkrError('ws-media payload size mismatch', {
      sentence: `the ws-media header promises ${payloadSize} payload bytes but the message carries ${actual}`,
    });
  }
  return {
    mediaType,
    ptsUs: buf.readBigInt64BE(1),
    durationUs: buf.readBigUInt64BE(9),
    payloadSize,
    payload: buf.subarray(WS_MEDIA_HEADER_SIZE),
  };
}

function tryParseWsMediaPacket(bytes) {
  try {
    return parseWsMediaPacket(bytes);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- JPEG byte splitter */

/**
 * Cut a byte stream that contains back-to-back JPEGs into complete images.
 *
 * ffmpeg's image2pipe mjpeg output is exactly that: `FF D8 … FF D9` repeated.
 * Huffman-coded scan data never contains a bare `FF D9` (0xFF is stuffed as
 * `FF 00`), so the terminator search cannot end a frame early.
 */
export class JpegStreamSplitter {
  #buffer = Buffer.alloc(0);
  #maxBytes;

  constructor({ maxBytes = 8 * 1024 * 1024 } = {}) {
    this.#maxBytes = maxBytes;
  }

  /** Bytes kept between chunks (a partial JPEG). */
  get pending() {
    return this.#buffer.length;
  }

  /**
   * Feed a chunk, get every JPEG it completed.
   * @param {Uint8Array|Buffer} chunk
   * @returns {Buffer[]}
   */
  push(chunk) {
    const data = toBuffer(chunk);
    if (!data || data.length === 0) return [];
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(data) : Buffer.concat([this.#buffer, data]);
    const frames = [];
    for (;;) {
      const soi = this.#buffer.indexOf(JPEG_SOI_BYTES);
      if (soi < 0) {
        // Keep a trailing 0xFF: it may be the first byte of a split SOI.
        const keep = this.#buffer.length > 0 && this.#buffer[this.#buffer.length - 1] === 0xff ? 1 : 0;
        this.#buffer = keep ? this.#buffer.subarray(this.#buffer.length - 1) : Buffer.alloc(0);
        break;
      }
      if (soi > 0) this.#buffer = this.#buffer.subarray(soi);
      const eoi = this.#buffer.indexOf(JPEG_EOI_BYTES, 2);
      if (eoi < 0) {
        // A runaway "JPEG" means we lost the stream; drop it rather than grow forever.
        if (this.#buffer.length > this.#maxBytes) this.#buffer = Buffer.alloc(0);
        break;
      }
      frames.push(this.#buffer.subarray(0, eoi + 2));
      this.#buffer = this.#buffer.subarray(eoi + 2);
    }
    return frames;
  }

  reset() {
    this.#buffer = Buffer.alloc(0);
  }
}

/* --------------------------------------------------------------------- misc */

/**
 * ws(s)://<host>/ws/media?authorization=<token>, derived from the http origin.
 * @param {string} origin e.g. 'http://linkr.local'
 * @param {string} answer
 */
export function buildMediaUrl(origin, answer) {
  const text = String(origin ?? '').trim().replace(/\/+$/, '');
  const secure = /^https:/i.test(text);
  const hostPart = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return `${secure ? 'wss' : 'ws'}://${hostPart}/ws/media?authorization=${encodeURIComponent(String(answer))}`;
}

/**
 * Width/height from a JPEG's SOF segment, without decoding the pixels.
 * @param {Uint8Array|Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function jpegSize(bytes) {
  const buf = toBuffer(bytes) ?? Buffer.alloc(0);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    // 0xFF fill bytes before a marker are legal.
    while (i + 1 < buf.length && buf[i + 1] === 0xff) i += 1;
    if (i + 1 >= buf.length) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: header segments are done
    if (i + 4 > buf.length) break;
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

function isJpeg(buf) {
  return buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

function waitFor(promise, timeoutMs, message, meta = {}) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new LinkrError('media timeout', { sentence: message, ...meta }));
    }, Math.max(1, timeoutMs));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A single media socket: JPEG frames out, HID frames in. The JPEGs may come
 * straight from the device (mjpeg) or out of the ffmpeg decoder (h264).
 */
export class MediaSession {
  #device;
  #fps;
  #codec;
  #ffmpegPath;
  #jpegQuality;
  #ws = null;
  #starting = null;
  #stopping = false;
  #frames = 0;
  #seq = 0;
  #packets = 0;
  #latest = null;
  #frameTimes = [];
  #listeners = new Set();
  #closeListeners = new Set();
  #waiters = new Set();
  #decodeListeners = new Set();
  #decoder = null;
  #decoderPath = '';
  #decoderStderr = '';
  #decoderFailed = false;
  #decoderError = null;
  #splitter = null;

  /**
   * @param {import('./linkr.js').LinkrDevice} device
   * @param {{ fps?: number, codec?: 'mjpeg'|'h264', ffmpegPath?: string, jpegQuality?: number }} [options]
   */
  constructor(device, { fps = 10, codec = 'mjpeg', ffmpegPath = '', jpegQuality = DEFAULT_JPEG_QUALITY } = {}) {
    this.#device = device;
    this.#fps = Number.isFinite(fps) && fps > 0 ? fps : 10;
    this.#codec = codec === 'h264' ? 'h264' : 'mjpeg';
    this.#ffmpegPath = String(ffmpegPath ?? '');
    this.#jpegQuality = clampJpegQuality(jpegQuality);
  }

  /** The device client this session talks to. */
  get device() {
    return this.#device;
  }

  /** Requested frame rate hint (the device sends what it sends). */
  get fps() {
    return this.#fps;
  }

  /** 'mjpeg' | 'h264' — which source codec this session uses. */
  get codec() {
    return this.#codec;
  }

  /** Path of the ffmpeg binary actually used, '' until the decoder starts. */
  get ffmpegPath() {
    return this.#decoderPath;
  }

  /** Live decoder pid, 0 when the h264 path is not running. */
  get decoderPid() {
    return this.#decoder?.pid ?? 0;
  }

  get open() {
    return this.#ws !== null && this.#ws.readyState === 1;
  }

  /** @returns {{ frames: number, fps: number, lastFrameAt: number, width: number, height: number, mode: string, codec: string, packets: number, decoder: string|null }} */
  get stats() {
    return {
      frames: this.#frames,
      fps: this.#measuredFps(),
      lastFrameAt: this.#latest?.at ?? 0,
      width: this.#latest?.width ?? 0,
      height: this.#latest?.height ?? 0,
      mode: this.open ? (this.#codec === 'h264' ? 'ws_h264' : 'ws_mjpeg') : 'closed',
      codec: this.#codec,
      packets: this.#packets,
      decoder: this.#decoder ? 'ffmpeg' : null,
    };
  }

  /** Newest accepted frame, or null. */
  latest() {
    return this.#latest;
  }

  /**
   * Negotiate + connect + start the decoder (h264) + wait for the first frame.
   * @param {{ timeoutMs?: number }} [options]
   */
  async start({ timeoutMs = 12000 } = {}) {
    if (this.open) return this;
    if (this.#starting) return this.#starting;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 12000;
    this.#starting = this.#doStart(budget).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #doStart(budget) {
    const deadline = Date.now() + budget;
    this.#stopping = false;
    this.#decoderFailed = false;
    this.#decoderError = null;

    const offer = this.#codec === 'h264' ? 'ws_h264' : 'ws_mjpeg';
    const { answer } = await this.#device.whep(offer);
    const url = buildMediaUrl(this.#device.origin, answer);

    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') {
      throw new LinkrError('no WebSocket global', {
        sentence: 'this Node runtime has no global WebSocket (needs Node 22+); the media channel cannot open',
      });
    }

    const ws = new WS(url, [MEDIA_SUBPROTOCOL]);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;

    const opened = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        () => {
          reject(
            new LinkrError('media socket error', {
              sentence:
                this.#codec === 'h264'
                  ? 'the device closed the H.264 media socket before it opened: check that the device is in H.264 mode and reachable'
                  : 'the device closed the media socket before it opened: check that the device is in MJPEG mode and reachable',
            }),
          );
        },
        { once: true },
      );
    });
    // Keep the socket identity: stop() + start() can replace `#ws` before this
    // socket's close event arrives, and that late event must not tear down the
    // new session.
    ws.addEventListener('message', (event) => this.#onMessage(ws, event));
    ws.addEventListener('close', (event) => this.#onClose(ws, event));

    try {
      const openBudget = Math.max(1000, deadline - Date.now());
      await waitFor(opened, openBudget, `the media socket did not open within ${openBudget} ms`);
      if (this.#codec === 'h264') this.#startDecoder();
      const frameBudget = Math.max(500, deadline - Date.now());
      await this.waitFrame({ after: 0, timeoutMs: frameBudget });
    } catch (error) {
      this.stop();
      throw error;
    }
    return this;
  }

  /**
   * Newest frame with seq > after.
   * @param {{ after?: number, timeoutMs?: number }} [options]
   */
  async waitFrame({ after = 0, timeoutMs = 5000 } = {}) {
    if (this.#latest && this.#latest.seq > after) return this.#latest;
    if (!this.open) {
      throw new LinkrError('no live media socket', {
        sentence: 'no live media session: call linkr_connect first',
      });
    }
    // The decoder can die before the first frame is requested; do not sit on a
    // 12 s timeout when the failure is already known.
    if (this.#decoderError) throw this.#decoderError;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(
          new LinkrError('frame wait timed out', {
            sentence: `no new frame arrived within ${budget} ms: the controlled host may be asleep or the HDMI signal is gone`,
          }),
        );
      }, budget);
      this.#waiters.add(waiter);
    });
  }

  /**
   * Subscribe to every accepted frame.
   * @param {(frame: { seq: number, jpeg: Buffer, width: number, height: number, at: number }) => void} listener
   * @returns {() => void}
   */
  onFrame(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Called when the socket closes without us asking (device reset, network drop).
   * @param {(reason: string) => void} listener
   */
  onClose(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /**
   * Called when the H.264 decode path dies (ffmpeg crash, bad stream, missing
   * binary). The frame waiters have already been rejected by then.
   * @param {(error: LinkrError) => void} listener
   */
  onDecodeError(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#decodeListeners.add(listener);
    return () => this.#decodeListeners.delete(listener);
  }

  /** One HID frame (already encoded). Works on both codecs. */
  send(bytes) {
    if (!this.open) {
      throw new LinkrError('media socket is not open', {
        sentence: 'no live media session: call linkr_connect first',
      });
    }
    this.#ws.send(bytes);
  }

  /** Encode + send one mouse message from lib/hid.js. */
  sendMouse(message) {
    this.send(encodeMouse(message));
  }

  /** Encode + send one key transition from lib/hid.js. */
  sendKey(event) {
    this.send(encodeKey(event));
  }

  /** Close the socket and the decoder. Safe to call twice, and before start(). */
  stop() {
    const ws = this.#ws;
    this.#ws = null;
    this.#stopping = true;
    this.#failWaiters('the media session was stopped');
    this.#killDecoder();
    if (ws) {
      try {
        ws.close(1000, 'bye');
      } catch {
        // The socket may already be gone; nothing to do.
      }
    }
  }

  /* ------------------------------------------------------------ decoder (h264) */

  #startDecoder() {
    const { child, path } = spawnDecoder({
      ffmpegPath: this.#ffmpegPath,
      jpegQuality: this.#jpegQuality,
    });
    this.#decoder = child;
    this.#decoderPath = path;
    this.#decoderStderr = '';
    this.#decoderFailed = false;
    this.#splitter = new JpegStreamSplitter();

    child.stdout.on('data', (chunk) => this.#onDecoderStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.#decoderStderr = `${this.#decoderStderr}${chunk.toString('utf8')}`.slice(-400);
    });
    child.stdin.on('error', (error) => {
      this.#onDecoderFailure(`ffmpeg stdin closed: ${error?.message ?? error}`);
    });
    child.on('error', (error) => {
      this.#onDecoderFailure(`could not run ffmpeg: ${error?.message ?? error}`);
    });
    child.on('exit', (code, signal) => {
      if (this.#stopping) {
        this.#decoder = null;
        return;
      }
      const detail = this.#decoderStderr.trim();
      this.#decoder = null;
      this.#onDecoderFailure(
        `ffmpeg exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`,
      );
    });
  }

  #onDecoderStdout(chunk) {
    if (this.#stopping || !this.#splitter) return;
    for (const jpeg of this.#splitter.push(chunk)) this.#publishFrame(jpeg);
  }

  #onDecoderFailure(reason) {
    if (this.#decoderFailed || this.#stopping) return;
    this.#decoderFailed = true;
    const error = new LinkrError('H.264 decoder failed', {
      sentence: `H.264 decode failed: ${reason}`,
    });
    this.#decoderError = error;
    // A start() waiting on its first frame sees the same error.
    this.#failWaiters(error);
    for (const listener of [...this.#decodeListeners]) {
      try {
        listener(error);
      } catch {
        // a listener must not break the socket
      }
    }
  }

  #killDecoder() {
    const child = this.#decoder;
    this.#decoder = null;
    this.#splitter = null;
    if (!child) return;
    try {
      child.stdin.destroy();
    } catch {
      // already closed
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  /* ------------------------------------------------------------------- socket */

  #onMessage(ws, event) {
    if (this.#ws !== ws) return;
    const buf = toBuffer(event?.data);
    if (!buf) return;
    if (this.#codec === 'h264') {
      this.#onH264Data(buf);
      return;
    }
    if (!isJpeg(buf)) return; // control payloads are not frames
    this.#publishFrame(buf);
  }

  #onH264Data(buf) {
    let payload = buf;
    const packet = tryParseWsMediaPacket(buf);
    if (packet) {
      if (packet.mediaType !== WS_MEDIA_TYPE_VIDEO) return;
      payload = packet.payload;
    }
    if (!payload || payload.length === 0) return;
    this.#packets += 1;
    const child = this.#decoder;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return;
    try {
      child.stdin.write(payload);
    } catch {
      // The exit handler already reported the failure.
    }
  }

  #publishFrame(buf) {
    if (!isJpeg(buf)) return;
    const size = jpegSize(buf);
    this.#seq += 1;
    this.#frames += 1;
    const now = Date.now();
    this.#frameTimes.push(now);
    while (this.#frameTimes.length > 120) this.#frameTimes.shift();

    const frame = {
      seq: this.#seq,
      jpeg: buf,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      at: now,
    };
    this.#latest = frame;
    for (const listener of [...this.#listeners]) {
      try {
        listener(frame);
      } catch {
        // A panel/route listener must not break the socket loop.
      }
    }
    for (const waiter of [...this.#waiters]) {
      if (frame.seq > waiter.after) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  }

  #onClose(ws, event) {
    if (this.#ws !== ws) {
      // A socket that was already replaced (or stopped) by the time its close
      // event arrived. Our own stop() leaves #ws null, so settle the stopping
      // flag; a replaced socket must leave the new session untouched.
      if (this.#ws === null) this.#stopping = false;
      return;
    }
    const wasStopping = this.#stopping;
    this.#stopping = false;
    this.#ws = null;
    this.#failWaiters('the media socket closed');
    this.#killDecoder();
    if (!wasStopping) {
      const reason = String(event?.reason || '').trim();
      const detail = reason
        ? `the device closed the media socket: ${reason}`
        : `the device closed the media socket (code ${event?.code ?? 0})`;
      for (const listener of [...this.#closeListeners]) {
        try {
          listener(detail);
        } catch {
          // ignore listener failures
        }
      }
    }
  }

  #failWaiters(reason) {
    for (const waiter of [...this.#waiters]) {
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(
        reason instanceof LinkrError
          ? reason
          : new LinkrError(reason, { sentence: String(reason) }),
      );
    }
  }

  #measuredFps() {
    const now = Date.now();
    let count = 0;
    for (let i = this.#frameTimes.length - 1; i >= 0; i -= 1) {
      if (now - this.#frameTimes[i] > 1000) break;
      count += 1;
    }
    return count;
  }
}
