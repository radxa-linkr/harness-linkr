/**
 * Linkr device HTTP client.
 *
 * One device, one origin, one Bearer token. Everything the plugin knows about the
 * device protocol (CONTRACT.md §1) is implemented here and nowhere else:
 *
 *   POST /api/account/login  { username, passwd: sha256(SALT + plaintext) }
 *   any call                 Authorization: Bearer <jwt>
 *   every answer             { code, message, data }  — code 0 is success
 *   auth failure             HTTP 403 { code: 403, message: 'No Permisson' }
 *
 * Node built-ins only (global fetch), no dependencies.
 */

import { createHash } from 'node:crypto';

/** Fixed salt the firmware prepends before hashing the password. */
export const PASSWORD_SALT = 'RADXA_FIXED_SALT_v1';

/** Lowercase hex sha256 of the salted plaintext; the only form the device accepts. */
export function hashPassword(password) {
  return createHash('sha256')
    .update(PASSWORD_SALT + String(password ?? ''), 'utf8')
    .digest('hex');
}

/** Collapse a device / network message into one readable line. */
function oneLine(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * The single error type the transport throws.
 *
 * `sentence` is the one-line human explanation callers may show to a model or a
 * person; `message` keeps the technical detail for logs.
 */
export class LinkrError extends Error {
  /**
   * @param {string} message technical message (kept short)
   * @param {{ status?: number, code?: number, path?: string, sentence?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    const sentence = oneLine(meta.sentence ?? message ?? 'Linkr device error');
    super(sentence || 'Linkr device error');
    this.name = 'LinkrError';
    this.status = Number.isInteger(meta.status) ? meta.status : 0;
    this.code = Number.isInteger(meta.code) ? meta.code : 0;
    this.path = String(meta.path ?? '');
    // A machine-readable cause for callers that must branch (the panel's
    // clipboard probe: disabled, disconnected, unsupported), never for display.
    this.reason = String(meta.reason ?? '');
    this.sentence = sentence || 'Linkr device error';
    if (meta.cause !== undefined) this.cause = meta.cause;
  }

  toJSON() {
    return {
      name: this.name,
      sentence: this.sentence,
      status: this.status,
      code: this.code,
      path: this.path,
      reason: this.reason,
    };
  }
}

/** Strip trailing slashes and default the scheme to http (the device serves :80). */
export function normalizeOrigin(baseUrl) {
  let text = String(baseUrl ?? '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/, '');
}

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function envelopeMessage(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [body.message, body.msg, body.error];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '';
}

/** The device answers HTTP 429 with "Too many requests. Try again in 999.9ms". */
function rateLimitDelayMs(text, headers) {
  const header = Number(headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(2500, Math.ceil(header * 1000));
  const match = /try again in\s+([\d.]+)\s*ms/i.exec(String(text ?? ''));
  if (match) return Math.min(2500, Math.max(50, Math.ceil(Number(match[1]))));
  return 1000;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
  });
}

export class LinkrDevice {
  #origin;
  #username;
  #password;
  #timeoutMs;
  #token = '';
  #loginPromise = null;
  #disposed = false;

  /**
   * @param {{ baseUrl: string, username: string, password: string, timeoutMs?: number }} options
   */
  constructor({ baseUrl, username, password, timeoutMs = 8000 } = {}) {
    this.#origin = normalizeOrigin(baseUrl);
    if (!this.#origin) {
      throw new LinkrError('missing baseUrl', {
        sentence: 'no device address configured: set baseUrl to http://<device-ip>',
      });
    }
    this.#username = String(username ?? '');
    this.#password = String(password ?? '');
    this.#timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;
  }

  /** 'http://linkr.local' — trailing slash stripped, no path. */
  get origin() {
    return this.#origin;
  }

  get username() {
    return this.#username;
  }

  /** True once login() produced a token. */
  get hasToken() {
    return this.#token.length > 0;
  }

  /** Drop the cached token (re-login on the next authed call). */
  clearToken() {
    this.#token = '';
  }

  /**
   * The current bearer token, logging in once when there is none.
   *
   * The control WebSocket carries its credential in every message instead of in
   * the handshake, so it asks for the token rather than for a request.
   *
   * @returns {Promise<string>}
   */
  async token() {
    if (!this.#token) await this.login();
    return this.#token;
  }

  /**
   * Log in and cache the JWT. Concurrent calls share one request.
   * @returns {Promise<{ token: string, username: string }>}
   */
  async login() {
    if (this.#loginPromise) return this.#loginPromise;
    this.#loginPromise = this.#doLogin().finally(() => {
      this.#loginPromise = null;
    });
    return this.#loginPromise;
  }

  async #doLogin() {
    if (this.#disposed) {
      throw new LinkrError('device disposed', { sentence: 'the Linkr device client was disposed' });
    }
    if (!this.#username || !this.#password) {
      throw new LinkrError('missing credentials', {
        path: '/api/account/login',
        sentence: 'no device username/password configured: set them in the Linkr settings',
      });
    }
    const body = { username: this.#username, passwd: hashPassword(this.#password) };
    const data = await this.request('/api/account/login', {
      method: 'POST',
      body,
      auth: false,
      retryOnAuth: false,
    });
    const token = typeof data?.token === 'string' ? data.token : '';
    if (!token) {
      throw new LinkrError('login answer carried no token', {
        path: '/api/account/login',
        sentence: 'the device accepted the login but returned no token',
      });
    }
    if (data?.require_two_factor) {
      throw new LinkrError('two-factor required', {
        path: '/api/account/login',
        sentence:
          'the device account needs two-factor verification: sign in once in the device web UI, then retry',
      });
    }
    this.#token = token;
    return { token, username: this.#username };
  }

  /**
   * One HTTP call, envelope unwrapped.
   *
   * `data` is what the device put in `data`; a non-envelope 2xx body comes back as
   * `{ raw }`. A 403 with a stored token re-logs in exactly once.
   *
   * @param {string} path e.g. '/api/video/codec'
   * @param {{ method?: string, body?: unknown, auth?: boolean, timeoutMs?: number, retryOnAuth?: boolean }} [options]
   */
  async request(path, options = {}) {
    const method = String(options.method ?? 'GET').toUpperCase();
    const auth = options.auth !== false;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.#timeoutMs;
    const retryOnAuth = options.retryOnAuth !== false;

    if (auth && !this.#token) await this.login();
    return this.#send(path, { method, body: options.body, auth, timeoutMs, retryOnAuth, rateAttempt: 0 });
  }

  async #send(path, { method, body, auth, timeoutMs, retryOnAuth, rateAttempt = 0 }) {
    const url = this.#origin + path;
    const headers = { Accept: 'application/json' };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (auth && this.#token) headers.Authorization = `Bearer ${this.#token}`;

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new LinkrError(timedOut ? 'request timed out' : 'request failed', {
        path,
        sentence: timedOut
          ? `the Linkr device did not answer ${path} within ${timeoutMs} ms`
          : `cannot reach the Linkr device at ${this.#origin}: ${oneLine(error?.message ?? error)}`,
        cause: error,
      });
    }

    const text = await response.text().catch(() => '');
    const env = parseJson(text);
    const businessCode = env && Number.isInteger(env.code) ? env.code : 0;

    if (response.status === 403 || businessCode === 403) {
      if (auth && retryOnAuth) {
        this.#token = '';
        await this.login();
        return this.#send(path, { method, body, auth, timeoutMs, retryOnAuth: false, rateAttempt });
      }
      throw new LinkrError('device refused the request (403)', {
        status: response.status,
        code: businessCode || 403,
        path,
        sentence: `the device rejected the login for ${this.#username || 'this account'} (HTTP 403)`,
      });
    }

    // The firmware rate limits every route (~4-5 requests per second): back off and
    // retry once or twice instead of failing a capture on a burst of reads.
    if ((response.status === 429 || businessCode === 429) && rateAttempt < 2) {
      const delay = rateLimitDelayMs(text, response.headers);
      await sleep(delay);
      return this.#send(path, {
        method,
        body,
        auth,
        timeoutMs,
        retryOnAuth,
        rateAttempt: rateAttempt + 1,
      });
    }
    if (response.status === 429 || businessCode === 429) {
      throw new LinkrError('device is rate limiting requests', {
        status: 429,
        code: 429,
        path,
        sentence: `the device is rate limiting ${path}: wait a second and try again`,
      });
    }

    if (!response.ok) {
      const detail = envelopeMessage(env);
      throw new LinkrError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, {
        status: response.status,
        code: businessCode,
        path,
        sentence: detail
          ? `the device answered HTTP ${response.status} for ${path}: ${detail}`
          : `the device answered HTTP ${response.status} for ${path}`,
      });
    }

    if (businessCode !== 0) {
      const detail = envelopeMessage(env);
      throw new LinkrError(detail || `device error code ${businessCode}`, {
        status: response.status,
        code: businessCode,
        path,
        sentence: detail
          ? detail
          : `the device refused ${path} with error code ${businessCode}`,
      });
    }

    if (!env) {
      if (text.length === 0) return undefined;
      return { raw: text };
    }
    return env.data;
  }

  /** GET /linkr/info — unauthenticated; the firmware rate limits it to ~2/s. */
  async info() {
    return this.request('/linkr/info', { auth: false });
  }

  /** GET /api/device/info — model, serial, MACs, domain name. */
  async deviceInfo() {
    return this.request('/api/device/info');
  }

  /** GET /api/device/version — { version }. */
  async version() {
    return this.request('/api/device/version');
  }

  /** GET /api/video/codec → number (0 WebRTC, 1 MJPEG, 2 H.264, 3 H.265, -1 auto). */
  async videoMode() {
    const data = await this.request('/api/video/codec');
    const mode = data?.video_codec ?? data?.video_mode ?? data?.codec ?? data?.mode;
    if (!Number.isInteger(mode)) {
      throw new LinkrError('answer carried no video_codec', {
        path: '/api/video/codec',
        sentence: 'the device did not report its video mode',
      });
    }
    return mode;
  }

  /** POST /api/video/codec { video_codec: mode }. This is a device-wide setting. */
  async setVideoMode(mode) {
    if (!Number.isInteger(mode)) {
      throw new LinkrError('setVideoMode needs an integer', {
        path: '/api/video/codec',
        sentence: `refusing to write a non-integer video mode (${String(mode)})`,
      });
    }
    await this.request('/api/video/codec', {
      method: 'POST',
      body: { video_codec: mode },
      timeoutMs: 15000,
    });
  }

  /** POST /api/paste { text } — transport behaviour unverified on the real device. */
  async paste(text) {
    return this.request('/api/paste', {
      method: 'POST',
      body: { text: String(text ?? '') },
    });
  }

  /**
   * POST /api/rtc/whep { offer } → { answer, streamId }.
   * `answer` is a one-shot token valid ~10 s; it is the media socket's credential.
   */
  async whep(offer = 'ws_mjpeg') {
    const data = await this.request('/api/rtc/whep', {
      method: 'POST',
      body: { offer },
      timeoutMs: 10000,
    });
    const answer = typeof data?.answer === 'string' ? data.answer : '';
    if (!answer) {
      throw new LinkrError('whep answer carried no token', {
        path: '/api/rtc/whep',
        sentence: 'the device did not hand out a media token',
      });
    }
    const rawId = data?.stream_id ?? data?.streamId ?? '';
    return { answer, streamId: rawId === '' || rawId === undefined ? '' : String(rawId) };
  }

  /** Nothing to release today; kept so callers can treat device and client alike. */
  dispose() {
    this.#disposed = true;
    this.#token = '';
  }
}
