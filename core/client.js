/**
 * The orchestration the Host plugin talks to (CONTRACT.md §2.4).
 *
 * One device, one live media session, one video-mode debt:
 * `connect()` logs in, switches the device to MJPEG when that is allowed, opens
 * the media socket and remembers the mode it found; every stop path — idle,
 * disconnect, error, dispose — writes that mode back.
 *
 * Node built-ins only.
 */

import { LinkrDevice, LinkrError, normalizeOrigin } from './linkr.js';
import { MediaSession } from './media.js';
import { ClipboardChannel } from './control.js';
import { ffmpegAvailable, clampJpegQuality, DEFAULT_JPEG_QUALITY } from './ffmpeg.js';
import { setTimeout as delay, setImmediate as yieldInput } from 'node:timers/promises';
import {
  keyEventsForText,
  parseCombo,
  BUTTON_LEFT,
  BUTTON_RIGHT,
  MOUSE_DOWN,
  MOUSE_MOVE,
  MOUSE_UP,
  MOUSE_WHEEL,
} from './hid.js';

export { LinkrError } from './linkr.js';

/** Video modes the device understands (CONTRACT.md §1.3, §7.3). */
export const VIDEO_MODE_WEBRTC = 0;
export const VIDEO_MODE_MJPEG = 1;
export const VIDEO_MODE_H264 = 2;
/** Source codec → device video mode. */
const MODE_FOR_CODEC = { mjpeg: VIDEO_MODE_MJPEG, h264: VIDEO_MODE_H264 };
const CODECS = ['auto', 'mjpeg', 'h264'];

const DEFAULTS = {
  baseUrl: 'http://linkr.local',
  username: 'admin',
  password: '',
  manageVideoMode: true,
  fps: 20,
  idleStopMs: 120000,
  /** 'auto' = H.264 when ffmpeg is available, MJPEG otherwise. */
  codec: 'auto',
  ffmpegPath: '',
  jpegQuality: DEFAULT_JPEG_QUALITY,
  /** Opt-in `/api/paste` fast path; unverified transport, off unless asked for. */
  pasteFastPath: false,
};

/** Time the device needs after a video-mode write before WHEP works. */
const MODE_SWITCH_SETTLE_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sentenceOf(error) {
  if (error instanceof LinkrError) return error.sentence;
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  return String(error ?? 'unknown error').replace(/\s+/g, ' ').trim();
}

function asError(error, sentence) {
  if (error instanceof LinkrError) return error;
  return new LinkrError(error?.message ?? String(error), { sentence: sentence ?? sentenceOf(error), cause: error });
}

/**
 * The panel's machine reason for a failed clipboard probe. The transport names
 * the interesting ones (disabled, disconnected, unsupported); anything else is
 * a device error the reader can only read.
 */
function reasonOf(error) {
  if (error instanceof LinkrError && typeof error.reason === 'string' && error.reason !== '') return error.reason;
  return 'device-error';
}

function clamp01(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new LinkrError(`missing ${name}`, {
      sentence: `${name} is required and must be a number between 0 and 1`,
    });
  }
  return Math.min(1, Math.max(0, n));
}

function clampLines(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(-10, Math.min(10, n));
}

function normalizeOptions(options, base) {
  const next = { ...base };
  if (options === undefined || options === null) return next;
  if (typeof options !== 'object') {
    throw new LinkrError('configure expects an object', {
      sentence: 'configure() needs an options object',
    });
  }
  if (options.baseUrl !== undefined) {
    const origin = normalizeOrigin(options.baseUrl);
    if (!origin) {
      throw new LinkrError('empty baseUrl', {
        sentence: 'baseUrl is required, e.g. http://linkr.local',
      });
    }
    next.baseUrl = origin;
  }
  if (options.username !== undefined) next.username = String(options.username ?? '').trim();
  if (options.password !== undefined) next.password = String(options.password ?? '');
  if (options.manageVideoMode !== undefined) next.manageVideoMode = options.manageVideoMode !== false;
  if (options.fps !== undefined) {
    const fps = Math.trunc(Number(options.fps));
    next.fps = Number.isFinite(fps) ? Math.min(60, Math.max(1, fps)) : base.fps;
  }
  if (options.idleStopMs !== undefined) {
    const idle = Math.trunc(Number(options.idleStopMs));
    next.idleStopMs = Number.isFinite(idle) ? Math.max(0, idle) : base.idleStopMs;
  }
  if (options.codec !== undefined) {
    const codec = String(options.codec ?? '').trim().toLowerCase();
    if (!CODECS.includes(codec)) {
      throw new LinkrError(`unsupported codec "${codec}"`, {
        sentence: `unsupported codec "${codec}": use auto, mjpeg or h264`,
      });
    }
    next.codec = codec;
  }
  if (options.ffmpegPath !== undefined) next.ffmpegPath = String(options.ffmpegPath ?? '').trim();
  if (options.jpegQuality !== undefined) next.jpegQuality = clampJpegQuality(options.jpegQuality);
  if (options.pasteFastPath !== undefined) next.pasteFastPath = options.pasteFastPath === true;
  for (const key of ['beforeVideoModeChange', 'afterVideoModeRestore', 'onSessionEnd']) {
    if (typeof options[key] === 'function') next[key] = options[key];
  }
  return next;
}

export class LinkrClient {
  #config;
  #device = null;
  #devicePassword = '';
  #deviceInfo = null;
  #deviceInfoAt = 0;
  #session = null;
  #starting = null;
  #idleTimer = null;
  #videoMode = null;
  #priorMode = null;
  #modeOwned = false;
  #restoring = null;
  #error = '';
  #disposed = false;
  #stoppingSession = false;
  #pasteOk = null;
  #frameListeners = new Set();
  #activeCodec = null;
  #decodeBroken = false;
  #notice = '';
  #fallingBack = false;
  #clipboard = null;

  /**
   * @param {{ baseUrl?: string, username?: string, password?: string, manageVideoMode?: boolean,
   *           fps?: number, idleStopMs?: number, pasteFastPath?: boolean }} [options]
   */
  constructor(options = {}) {
    const pasteEnv = process.env.LINKR_PASTE === '1';
    const seed = pasteEnv ? { ...DEFAULTS, pasteFastPath: true } : { ...DEFAULTS };
    this.#config = normalizeOptions(options, seed);
  }

  /** 'http://linkr.local' — the configured device origin. */
  get origin() {
    return this.#config.baseUrl ? normalizeOrigin(this.#config.baseUrl) : '';
  }

  /** Plain JSON snapshot for tools, routes and the panel. */
  get state() {
    const session = this.#session;
    const stats = session?.stats;
    const info = this.#deviceInfo;
    return {
      configured: Boolean(this.#config.baseUrl && this.#config.username && this.#config.password),
      origin: this.origin,
      connected: session?.open === true,
      device: info
        ? {
            deviceName: info.deviceName ?? '',
            status: info.status ?? '',
            version: info.version ?? '',
            model: info.model ?? '',
            sn: info.sn ?? '',
            onlineTime: info.onlineTime ?? 0,
          }
        : null,
      videoMode: this.#videoMode,
      modeOwned: this.#modeOwned,
      frames: stats?.frames ?? 0,
      fps: stats?.fps ?? 0,
      width: stats?.width ?? 0,
      height: stats?.height ?? 0,
      lastFrameAt: stats?.lastFrameAt ?? 0,
      codec: this.#activeCodec ?? this.#resolveCodec(),
      decoder: this.#activeCodec === 'h264' ? 'ffmpeg' : null,
      notice: this.#notice,
      error: this.#error,
    };
  }

  /**
   * Apply a new configuration. A live session is dropped (and the device's video
   * mode restored) first, because the device it pointed at may no longer be ours.
   *
   * @returns {Promise<unknown>} resolves once the old session is gone
   */
  configure(options = {}) {
    const next = normalizeOptions(options, this.#config);
    const same = JSON.stringify(next) === JSON.stringify(this.#config);
    this.#config = next;
    this.#pasteOk = null;
    if (same) return Promise.resolve(this.state);
    const wasLive = this.#session !== null || this.#starting !== null;
    this.#deviceInfo = null;
    this.#deviceInfoAt = 0;
    this.#videoMode = null;
    this.#decodeBroken = false;
    this.#notice = '';
    if (wasLive) return this.disconnect();
    return Promise.resolve(this.state);
  }

  /** Login (once) + ensure a live media session. Concurrent calls share one start. */
  async connect() {
    if (this.#disposed) {
      throw new LinkrError('client disposed', {
        sentence: 'this Linkr client was disposed; create a new one',
      });
    }
    if (this.#session?.open) {
      this.#touch();
      return this.state;
    }
    if (this.#starting) return this.#starting;
    this.#starting = this.#startSession().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** Stop the session now and restore the device video mode. */
  async disconnect() {
    if (this.#starting) {
      // Let an in-flight start settle so we do not leak its socket/mode write.
      await this.#starting.catch(() => {});
    }
    await this.#teardown();
    return this.state;
  }

  /** Device identity and current video mode — never writes the video setting. */
  async probe() {
    const device = this.#ensureDevice();
    try {
      await device.login();
    } catch (error) {
      this.#error = sentenceOf(error);
      throw asError(error);
    }
    await this.#loadDeviceInfo(device, { force: true });
    this.#error = '';
    try {
      this.#videoMode = await device.videoMode();
    } catch (error) {
      // Reading the mode is optional for a probe; the error stays visible in state.
      this.#error = sentenceOf(error);
    }
    return {
      configured: true,
      origin: device.origin,
      device: this.state.device,
      videoMode: this.#videoMode,
      connected: this.#session?.open === true,
    };
  }

  /**
   * One fresh frame.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ jpeg: Buffer, width: number, height: number, at: number, seq: number }>}
   */
  async capture({ timeoutMs = 6000 } = {}) {
    const session = await this.#requireSession();
    const after = session.latest()?.seq ?? 0;
    let frame;
    try {
      frame = await session.waitFrame({ after, timeoutMs });
    } catch (error) {
      this.#error = sentenceOf(error);
      throw asError(error);
    }
    this.#error = '';
    this.#touch();
    return {
      jpeg: frame.jpeg,
      width: frame.width,
      height: frame.height,
      at: frame.at,
      seq: frame.seq,
    };
  }

  /**
   * Inject one input action on the controlled host.
   * @param {{ kind: 'mouse'|'key'|'text' } & Record<string, unknown>} action
   * @returns {Promise<{ applied: 'mouse'|'key'|'text', detail: Record<string, unknown> }>}
   */
  async input(action, { signal } = {}) {
    signal?.throwIfAborted();
    if (!action || typeof action !== 'object') {
      throw new LinkrError('input needs an action object', {
        sentence: 'input() needs an action object such as {kind:"mouse",action:"click",x:0.5,y:0.5}',
      });
    }
    const session = this.#session;
    if (!session || !session.open) {
      throw new LinkrError('no live session', {
        sentence: 'no live session; call linkr_status/linkr_connect first',
      });
    }
    const kind = String(action.kind ?? '').trim().toLowerCase();
    try {
      if (kind === 'mouse') {
        const detail = await this.#mouse(session, action, signal);
        this.#error = '';
        this.#touch();
        return { applied: 'mouse', detail };
      }
      if (kind === 'key') {
        // A panel forwards Space as a lone " "; name it instead of trimming it
        // into an empty combo.
        const rawCombo = String(action.combo ?? '');
        const combo = rawCombo === ' ' ? 'space' : rawCombo.trim();
        if (!combo) {
          throw new LinkrError('key input without combo', {
            sentence: 'key input needs a combo such as "ctrl+alt+t" or "Escape"',
          });
        }
        const events = parseCombo(combo);
        await this.#sendKeys(session, events, signal);
        this.#error = '';
        this.#touch();
        return { applied: 'key', detail: { combo, transitions: events.length } };
      }
      if (kind === 'text') {
        const detail = await this.#text(session, action, signal);
        this.#error = '';
        this.#touch();
        return { applied: 'text', detail };
      }
    } catch (error) {
      this.#error = sentenceOf(error);
      throw asError(error);
    }
    throw new LinkrError(`unsupported input kind "${kind}"`, {
      sentence: `unsupported input kind "${kind}": use mouse, key or text`,
    });
  }

  /* ----- Linkrd clipboard (CONTRACT §16) ----- */

  /** The clipboard channel: one per device, created on first use. */
  #clipboardChannel() {
    const device = this.#ensureDevice();
    if (!this.#clipboard) {
      this.#clipboard = new ClipboardChannel({
        origin: device.origin,
        // The control socket puts the token in every message, so it asks for the
        // current one instead of owning a copy that can go stale.
        token: () => device.token(),
      });
    }
    return this.#clipboard;
  }

  /**
   * One clipboard call, retried once when the device rejects the token.
   *
   * A 403 on the control socket means the JWT expired between the HTTP login and
   * the socket write; dropping the cached token and repeating the call is
   * exactly the recovery the device's own client performs.
   */
  async #withClipboard(fn) {
    const channel = this.#clipboardChannel();
    try {
      return await fn(channel);
    } catch (error) {
      if (error instanceof LinkrError && error.code === 403) {
        this.#device?.clearToken();
        return await fn(channel);
      }
      throw asError(error);
    }
  }

  /**
   * Whether the Linkrd clipboard can be used, and why not when it cannot.
   *
   * Never throws: a probe that fails is itself the answer, and the panel asks
   * this on mount where an exception would break the whole pane.
   *
   * @param {{ includeText?: boolean }} [options] include the host clipboard text
   * @returns {Promise<{ available: boolean, reason: string, message: string, enabled: boolean,
   *   connected: boolean, hasText: boolean, text: string, maxBytes: number }>}
   */
  async clipboardStatus({ includeText = false } = {}) {
    const empty = {
      available: false,
      reason: '',
      message: '',
      enabled: false,
      connected: false,
      hasText: false,
      text: '',
      maxBytes: 0,
    };
    try {
      this.#ensureDevice();
    } catch (error) {
      return { ...empty, reason: 'unconfigured', message: sentenceOf(error) };
    }
    try {
      const status = await this.#withClipboard((channel) => channel.status());
      return {
        available: true,
        reason: '',
        message: '',
        enabled: true,
        connected: true,
        hasText: status.hasText,
        text: includeText && status.hasText ? status.text : '',
        maxBytes: status.maxBytes,
      };
    } catch (error) {
      return { ...empty, reason: reasonOf(error), message: sentenceOf(error) };
    }
  }

  /** The controlled machine's clipboard, for `linkr_computer_use` action "clipboard". */
  async readClipboard() {
    return this.#withClipboard((channel) => channel.read());
  }

  /**
   * Put `text` on the controlled machine's clipboard, then press `keys` so it
   * lands in whatever window has focus.
   *
   * An empty `keys` only writes the clipboard: a terminal needs Ctrl+Shift+V,
   * a GUI app Ctrl+V, and this layer cannot know which one is in front — so the
   * caller chooses instead of being guessed at.
   *
   * @param {{ text: string, keys?: string }} options
   * @returns {Promise<{ bytes: number, maxBytes: number, revision: string, keys: string }>}
   */
  async paste({ text, keys = 'ctrl+v', signal } = {}) {
    signal?.throwIfAborted();
    const value = typeof text === 'string' ? text : '';
    if (value === '') {
      throw new LinkrError('nothing to paste', { sentence: 'paste needs a non-empty text' });
    }
    const combo = typeof keys === 'string' ? keys.trim() : '';
    // The clipboard write rides the control socket; the chord needs the HID media
    // session. Ask for the session first, so a missing one cannot leave a
    // clipboard behind that nobody pasted.
    if (combo) await this.#requireSession();
    signal?.throwIfAborted();
    let written;
    try {
      written = await this.#withClipboard((channel) => channel.write(value));
    } catch (error) {
      this.#error = sentenceOf(error);
      throw asError(error);
    }
    if (!combo) {
      this.#touch();
      return { bytes: written.bytes, maxBytes: written.maxBytes, revision: written.revision, keys: '' };
    }
    signal?.throwIfAborted();
    const applied = await this.input({ kind: 'key', combo }, { signal });
    return {
      bytes: written.bytes,
      maxBytes: written.maxBytes,
      revision: written.revision,
      keys: combo,
      transitions: applied.detail.transitions,
    };
  }

  /**
   * Subscribe to every frame of the live session (panel mirroring).
   * @param {(frame: { seq: number, jpeg: Buffer, width: number, height: number, at: number }) => void} listener
   */
  onFrame(listener) {
    if (typeof listener !== 'function') return () => {};
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** Newest frame of the live session, or null. */
  latest() {
    return this.#session?.latest() ?? null;
  }

  /** A mounted viewer may keep an existing session alive, never start one. */
  keepAlive() {
    if (this.#session?.open) this.#touch();
    return this.state;
  }

  /** Stop everything and give the device its video mode back. */
  async dispose() {
    this.#disposed = true;
    this.#clearIdle();
    await this.#starting?.catch(() => {});
    await this.#teardown();
    if (this.#device) {
      try {
        this.#device.dispose();
      } catch {
        // nothing to release
      }
    }
    this.#frameListeners.clear();
    return this.state;
  }

  /* ------------------------------------------------------------------ internals */

  #ensureDevice() {
    if (this.#disposed) {
      throw new LinkrError('client disposed', {
        sentence: 'this Linkr client was disposed; create a new one',
      });
    }
    const { baseUrl, username, password } = this.#config;
    if (!baseUrl) {
      throw new LinkrError('not configured', {
        sentence: 'no device address configured: set baseUrl to http://<device-ip>',
      });
    }
    if (!username || !password) {
      throw new LinkrError('not configured', {
        sentence: 'no device credentials configured: set the Linkr username and password first',
      });
    }
    const origin = normalizeOrigin(baseUrl);
    const stale =
      !this.#device ||
      this.#device.origin !== origin ||
      this.#device.username !== username ||
      this.#devicePassword !== password;
    if (stale) {
      this.#device?.dispose();
      this.#device = new LinkrDevice({ baseUrl: origin, username, password });
      this.#devicePassword = password;
      // The control socket authenticates against the device that just went away.
      this.#dropClipboard();
    }
    return this.#device;
  }

  /** Close the clipboard channel, if one was opened. */
  #dropClipboard() {
    const channel = this.#clipboard;
    this.#clipboard = null;
    if (channel) {
      try {
        channel.close();
      } catch {
        // already closed
      }
    }
  }

  /** Which source codec this client will ask the device for. */
  #resolveCodec() {
    if (this.#config.codec === 'mjpeg') return 'mjpeg';
    if (this.#config.codec === 'h264') return 'h264';
    // auto: H.264 only when a decoder is actually runnable on this machine.
    if (this.#decodeBroken) return 'mjpeg';
    return ffmpegAvailable(this.#config.ffmpegPath) ? 'h264' : 'mjpeg';
  }

  async #startSession() {
    const codec = this.#resolveCodec();
    try {
      return await this.#startWith(codec);
    } catch (error) {
      // H.264 is the preferred path, not a requirement: degrade to MJPEG once and
      // say so, exactly like a missing ffmpeg must never crash a capture.
      if (codec === 'h264' && !this.#fallingBack) {
        this.#decodeBroken = true;
        this.#notice = `H.264 unavailable (${sentenceOf(error)}); using MJPEG`;
        try {
          return await this.#startWith('mjpeg');
        } catch (fallbackError) {
          this.#error = sentenceOf(fallbackError);
          throw asError(fallbackError);
        }
      }
      throw asError(error);
    }
  }

  async #startWith(codec) {
    const device = this.#ensureDevice();
    this.#error = '';
    this.#stoppingSession = false;
    try {
      await device.login();
      await this.#loadDeviceInfo(device);
      await this.#ensureVideoMode(device, codec);

      const session = new MediaSession(device, {
        fps: this.#config.fps,
        codec,
        ffmpegPath: this.#config.ffmpegPath,
        jpegQuality: this.#config.jpegQuality,
      });
      this.#session = session;
      this.#activeCodec = codec;
      session.onFrame((frame) => this.#emitFrame(frame));
      session.onClose((reason) => this.#onSessionClosed(reason));
      session.onDecodeError((error) => this.#onSessionDecodeError(session, error));
      await session.start({ timeoutMs: 12000 });
      this.#touch();
      return this.state;
    } catch (error) {
      this.#stoppingSession = true;
      await this.#teardown();
      this.#stoppingSession = false;
      this.#error = sentenceOf(error);
      throw asError(error);
    }
  }

  /** ffmpeg died mid-session: swap the live session to MJPEG once. */
  #onSessionDecodeError(session, error) {
    if (this.#disposed || this.#stoppingSession || this.#fallingBack) return;
    if (session !== this.#session) return;
    if (this.#starting) return; // start() will reject and its catch handles it
    this.#decodeBroken = true;
    this.#notice = `H.264 decode failed (${sentenceOf(error)}); switched to MJPEG`;
    this.#fallbackToMjpeg().catch((fallbackError) => {
      this.#error = sentenceOf(fallbackError);
    });
  }

  async #fallbackToMjpeg() {
    if (this.#fallingBack) return;
    this.#fallingBack = true;
    try {
      await this.#teardown();
      if (this.#disposed) return;
      await this.#startWith('mjpeg');
    } finally {
      this.#fallingBack = false;
    }
  }

  async #requireSession() {
    if (this.#session?.open) return this.#session;
    await this.connect();
    if (!this.#session?.open) {
      throw new LinkrError('no live session', {
        sentence: 'no live session; call linkr_status/linkr_connect first',
      });
    }
    return this.#session;
  }

  async #loadDeviceInfo(device, { force = false } = {}) {
    // The device rate limits every route to a few requests per second; identity does
    // not change minute to minute, so a fresh cache avoids burning the budget.
    if (!force && this.#deviceInfo && Date.now() - this.#deviceInfoAt < 30000) return;
    const [info, hardware, version] = await Promise.all([
      device.info().catch(() => null),
      device.deviceInfo().catch(() => null),
      device.version().catch(() => null),
    ]);
    if (!info && !hardware && !version) return;
    this.#deviceInfo = {
      deviceName: info?.deviceName ?? this.#deviceInfo?.deviceName ?? '',
      status: info?.status ?? this.#deviceInfo?.status ?? '',
      onlineTime: info?.onlineTime ?? this.#deviceInfo?.onlineTime ?? 0,
      version: version?.version ?? info?.version ?? this.#deviceInfo?.version ?? '',
      model: hardware?.model ?? this.#deviceInfo?.model ?? '',
      sn: hardware?.sn ?? this.#deviceInfo?.sn ?? '',
    };
    this.#deviceInfoAt = Date.now();
  }

  async #ensureVideoMode(device, codec) {
    const target = MODE_FOR_CODEC[codec] ?? VIDEO_MODE_MJPEG;
    const label = codec === 'h264' ? 'H.264' : 'MJPEG';
    const current = await device.videoMode();
    this.#videoMode = current;
    if (current === target) {
      // Already in the mode we need: we own nothing and will write nothing back.
      return;
    }
    if (!this.#config.manageVideoMode) {
      throw new LinkrError('device is not in the codec mode we need', {
        path: '/api/video/codec',
        sentence: `the device video mode is ${current}, not ${target} (${label}), and manageVideoMode is off, so frames cannot be read; switch the device to ${label} in its web UI or enable manageVideoMode`,
      });
    }
    await this.#config.beforeVideoModeChange?.({ origin: device.origin, priorMode: current, targetMode: target });
    this.#priorMode = current;
    this.#modeOwned = true;
    try {
      await device.setVideoMode(target);
    } catch (error) {
      // A failed response may follow an applied write. Teardown still owes the prior mode.
      throw asError(
        error,
        `could not switch the device to ${label} (video mode ${current} -> ${target}): ${sentenceOf(error)}`,
      );
    }
    this.#videoMode = target;
    await sleep(MODE_SWITCH_SETTLE_MS);
  }

  async #restoreVideoMode() {
    if (!this.#modeOwned || this.#priorMode === null || !this.#device) return false;
    if (this.#restoring) return this.#restoring;
    const prior = this.#priorMode;
    const device = this.#device;
    this.#restoring = (async () => {
      try {
        await device.setVideoMode(prior);
        this.#videoMode = prior;
        this.#modeOwned = false;
        this.#priorMode = null;
        await this.#config.afterVideoModeRestore?.({ origin: device.origin, mode: prior });
        return true;
      } catch (error) {
        // Keep modeOwned so a later dispose/stop retries; surface it.
        this.#error = `could not restore the device video mode to ${prior}: ${sentenceOf(error)}`;
        return false;
      } finally {
        this.#restoring = null;
      }
    })();
    return this.#restoring;
  }

  /** Let the owner release per-session resources (the MCP server: its lease). */
  async #notifySessionEnd(reason) {
    try {
      await this.#config.onSessionEnd?.({ reason });
    } catch {
      /* a cleanup callback must never break teardown */
    }
  }

  async #teardown() {
    this.#clearIdle();
    this.#dropClipboard();
    const session = this.#session;
    this.#session = null;
    this.#activeCodec = null;
    if (session) {
      this.#stoppingSession = true;
      try {
        session.stop();
      } catch {
        // already closed
      }
      this.#stoppingSession = false;
    }
    await this.#restoreVideoMode();
    await this.#notifySessionEnd('disconnect');
  }

  #onSessionClosed(reason) {
    if (this.#stoppingSession) return;
    this.#error = reason;
    this.#clearIdle();
    const session = this.#session;
    this.#session = null;
    this.#activeCodec = null;
    try {
      session?.stop();
    } catch {
      // ignore
    }
    // The session is gone; the device still owes us the old video mode.
    this.#restoreVideoMode().catch(() => {});
  }

  #emitFrame(frame) {
    for (const listener of [...this.#frameListeners]) {
      try {
        listener(frame);
      } catch {
        // a broken listener must not break the socket
      }
    }
  }

  async #mouse(session, action, signal) {
    signal?.throwIfAborted();
    const name = String(action.action ?? '').trim().toLowerCase();
    const point = () => ({
      x: clamp01(action.x, 'x'),
      y: clamp01(action.y, 'y'),
    });

    if (name === 'move') {
      const { x, y } = point();
      session.sendMouse({ type: MOUSE_MOVE, buttons: 0, x, y });
      return { action: 'move', x, y };
    }

    if (name === 'click' || name === 'double_click' || name === 'right_click') {
      const { x, y } = point();
      const buttons = name === 'right_click' || action.button === 'right' ? BUTTON_RIGHT : BUTTON_LEFT;
      const repeat = name === 'double_click' ? 2 : 1;
      session.sendMouse({ type: MOUSE_MOVE, buttons: 0, x, y });
      for (let i = 0; i < repeat; i += 1) {
        signal?.throwIfAborted();
        session.sendMouse({ type: MOUSE_DOWN, buttons, x, y });
        try { await delay(12, undefined, { signal }); }
        finally { if (session.open) session.sendMouse({ type: MOUSE_UP, buttons: 0, x, y }); }
        if (i + 1 < repeat) await delay(60, undefined, { signal });
      }
      return {
        action: name,
        x,
        y,
        button: buttons === BUTTON_RIGHT ? 'right' : 'left',
        clicks: repeat,
      };
    }

    if (name === 'scroll') {
      const x = action.x === undefined ? 0.5 : clamp01(action.x, 'x');
      const y = action.y === undefined ? 0.5 : clamp01(action.y, 'y');
      const wheelY = clampLines(action.wheelY);
      const wheelX = clampLines(action.wheelX);
      if (wheelY === 0 && wheelX === 0) {
        throw new LinkrError('scroll without delta', {
          sentence: 'scroll needs wheelY (or wheelX) in lines; the sign gives the direction',
        });
      }
      session.sendMouse({ type: MOUSE_WHEEL, buttons: 0, x, y, wheelY, wheelX });
      return { action: 'scroll', x, y, wheelY, wheelX };
    }

    if (name === 'drag') {
      const { x, y } = point();
      const toX = clamp01(action.toX, 'toX');
      const toY = clamp01(action.toY, 'toY');
      const buttons = String(action.button ?? 'left').toLowerCase() === 'right' ? BUTTON_RIGHT : BUTTON_LEFT;
      session.sendMouse({ type: MOUSE_MOVE, buttons: 0, x, y });
      session.sendMouse({ type: MOUSE_DOWN, buttons, x, y });
      const steps = 4;
      let last = { x, y };
      try {
        for (let i = 1; i <= steps; i += 1) {
          signal?.throwIfAborted();
          const t = i / steps;
          last = { x: x + (toX - x) * t, y: y + (toY - y) * t };
          session.sendMouse({ type: MOUSE_MOVE, buttons, ...last });
          await delay(16, undefined, { signal });
        }
      } finally { if (session.open) session.sendMouse({ type: MOUSE_UP, buttons: 0, ...last }); }
      return { action: 'drag', x, y, toX, toY, button: buttons === BUTTON_RIGHT ? 'right' : 'left' };
    }

    throw new LinkrError(`unsupported mouse action "${name}"`, {
      sentence: `unsupported mouse action "${name}": use move, click, double_click, right_click, scroll or drag`,
    });
  }

  async #sendKeys(session, events, signal) {
    const held = new Map();
    try {
      for (let i = 0; i < events.length; i += 1) {
        signal?.throwIfAborted();
        const event = events[i];
        session.sendKey(event);
        if (event.down) held.set(event.code, event); else held.delete(event.code);
        if (i % 32 === 31) await yieldInput();
      }
    } finally {
      if (session.open) for (const event of held.values()) session.sendKey({ ...event, down: false });
    }
  }

  async #text(session, action, signal) {
    const text = String(action.text ?? '');
    if (!text) {
      throw new LinkrError('text input without text', {
        sentence: 'text input needs a non-empty text string',
      });
    }
    // Validate against the US layout before anything touches the device.
    const events = keyEventsForText(text);

    if (this.#config.pasteFastPath && this.#pasteOk !== false && !/[\r\n\t]/.test(text)) {
      try {
        await session.device.paste(text);
        this.#pasteOk = true;
        return { via: 'paste', chars: [...text].length };
      } catch {
        // Fast path refused: fall back to real key events for the rest of the session.
        this.#pasteOk = false;
      }
    }
    await this.#sendKeys(session, events, signal);
    return { via: 'keys', chars: [...text].length, transitions: events.length };
  }

  #touch() {
    this.#clearIdle();
    if (this.#disposed) return;
    const idleStopMs = this.#config.idleStopMs;
    if (!Number.isFinite(idleStopMs) || idleStopMs <= 0) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      // Idle stop is a normal event, not an error.
      this.disconnect().catch(() => {});
    }, idleStopMs);
  }

  #clearIdle() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}
