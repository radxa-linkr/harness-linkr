/**
 * A loopback web panel for the native plugin.
 *
 * The plugin has no UI host of its own (OpenCode's TUI/desktop parts are
 * separate APIs), so `linkr_panel` starts a tiny HTTP server on 127.0.0.1 that
 * serves a live screen page: an MJPEG stream from the same session the tools
 * drive, a snapshot, JSON state/activity, and an input endpoint that forwards
 * pointer/keyboard/paste actions to the Linkr tools.
 *
 * Security posture: bound to the loopback interface only, every request needs
 * the random token in the URL, and the token is generated per start. The page
 * can drive a real machine, so it is never exposed on a LAN interface.
 *
 * The server is transport-agnostic: it only calls the tools instance
 * (`callTool`, `onFrame`, `panelState`, `stop`), which is what makes it
 * testable with a stub.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ASSETS = new Map([
  ['/', ['panel/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['panel/index.html', 'text/html; charset=utf-8']],
  ['/panel.css', ['panel/panel.css', 'text/css; charset=utf-8']],
  ['/panel.js', ['panel/panel.js', 'text/javascript; charset=utf-8']],
]);

const BOUNDARY = 'linkrframe';
const ACTIONS = new Set(['capture', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait', 'paste', 'clipboard', 'move']);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

async function readBody(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

/**
 * Start a panel server.
 *
 * @param {{ tools: object, host?: string, port?: number, fps?: number, token?: string }} options
 */
export async function createPanelServer({ tools, host = '127.0.0.1', port = 0, fps = 10, detachGraceMs = 8000, token = randomBytes(16).toString('hex') } = {}) {
  if (!tools || typeof tools.callTool !== 'function') throw new Error('createPanelServer needs the Linkr tools instance');

  const subscribers = new Set();
  const blocked = new Set();
  const tokenValue = String(token);
  let stopFrames = null;
  let lastFrame = null;
  let lastBroadcastAt = 0;
  let lastError = '';
  let closed = false;
  /** True when this panel is the component that opened the device session. */
  let panelStarted = false;
  let detachTimer = null;

  const interval = 1000 / Math.max(1, Math.min(30, Number(fps) || 10));

  function broadcast(frame) {
    if (frame?.jpeg === undefined) return;
    // A mounted viewer is still using the device: without this an idleStopMs
    // timeout would stop the session under an open panel after two minutes.
    tools.keepAlive?.();
    const now = Date.now();
    if (now - lastBroadcastAt < interval) return;
    lastBroadcastAt = now;
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`, 'utf8');
    const tail = Buffer.from('\r\n', 'utf8');
    const part = Buffer.concat([head, frame.jpeg, tail]);
    for (const response of subscribers) {
      // A slow browser keeps only the newest frame; its socket buffer stays
      // bounded instead of queueing every frame of the stream.
      if (blocked.has(response)) continue;
      try {
        if (!response.write(part)) blocked.add(response);
      } catch {
        subscribers.delete(response);
        blocked.delete(response);
      }
    }
  }

  function watchFrames() {
    if (stopFrames !== null || typeof tools.onFrame !== 'function') return;
    stopFrames = tools.onFrame((frame) => {
      lastFrame = frame;
      lastError = '';
      broadcast(frame);
    });
  }

  function unwatchFramesIfIdle() {
    if (subscribers.size > 0 || stopFrames === null) return;
    try {
      stopFrames();
    } catch {
      /* a disposed client must not break the panel */
    }
    stopFrames = null;
  }

  async function ensureSession() {
    // The first capture opens the device session; frames then arrive through
    // the session's listener and are fanned out to the browser.
    const wasConnected = tools.panelState?.()?.state?.connected === true;
    const result = await tools.callTool('linkr_computer_use', { action: 'capture' }, {});
    if (result?.isError === true) {
      const text = (result.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ');
      throw new Error(text === '' ? 'the device is not available' : text);
    }
    if (!wasConnected && tools.panelState?.()?.state?.connected === true) panelStarted = true;
    return result;
  }

  function clearDetach() {
    if (detachTimer !== null) {
      clearTimeout(detachTimer);
      detachTimer = null;
    }
  }

  /**
   * Last viewer gone: if this panel opened the session and the agent has not
   * used it lately, end it after a short grace so the device and its lease are
   * free. A reconnect (new viewer) cancels the timer.
   */
  function scheduleDetach() {
    if (!panelStarted || subscribers.size > 0 || typeof tools.releaseIfIdle !== 'function') return;
    clearDetach();
    detachTimer = setTimeout(() => {
      detachTimer = null;
      Promise.resolve()
        .then(() => tools.releaseIfIdle({ idleMs: detachGraceMs }))
        .then((released) => {
          if (released === true) panelStarted = false;
        })
        .catch(() => {});
    }, Math.max(0, Number(detachGraceMs) || 0));
    detachTimer.unref?.();
  }

  async function handleStream(request, response) {
    response.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
    });
    // Flush the headers now: the browser (and the smoke test) must see the
    // stream open before the first frame exists.
    response.flushHeaders?.();
    subscribers.add(response);
    clearDetach();
    // A new viewer starts a new session: do not replay the last frame of a
    // previous one while the device connects.
    if (subscribers.size === 1) lastFrame = null;
    try {
      await ensureSession();
    } catch (error) {
      lastError = String(error?.message ?? error);
      response.write(Buffer.from(`--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\n${lastError}\r\n`));
      response.end();
      subscribers.delete(response);
      blocked.delete(response);
      return;
    }
    watchFrames();
    if (lastFrame !== null) broadcast(lastFrame);
    response.on('drain', () => blocked.delete(response));
    request.on('close', () => {
      subscribers.delete(response);
      blocked.delete(response);
      unwatchFramesIfIdle();
      scheduleDetach();
    });
  }

  function panelState() {
    let state = {};
    let activity = [];
    try {
      const snapshot = tools.panelState?.() ?? {};
      state = snapshot.state ?? {};
      activity = Array.isArray(snapshot.activity) ? snapshot.activity.slice(0, 8) : [];
    } catch {
      /* no session yet */
    }
    const size = lastFrame !== null ? { width: lastFrame.width ?? 0, height: lastFrame.height ?? 0 } : { width: 0, height: 0 };
    return {
      ok: true,
      error: lastError,
      state: {
        connected: Boolean(state.connected),
        codec: typeof state.codec === 'string' ? state.codec : '',
        width: size.width,
        height: size.height,
        fps: Number(state.fps) || 0,
        subscribers: subscribers.size,
      },
      activity,
    };
  }

  async function handleSnapshot(response) {
    const result = await tools.callTool('linkr_computer_use', { action: 'capture' }, {});
    if (result?.isError === true) throw new Error('the device is not available');
    const path = typeof result?.value?.path === 'string' ? result.value.path : '';
    if (path === '') throw new Error('capture path is missing');
    const jpeg = await readFile(path);
    response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
    response.end(jpeg);
  }

  async function handleInput(request, response) {
    const body = await readBody(request);
    const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';
    if (action === 'disconnect') {
      try {
        await tools.stop?.();
      } catch {
        /* already stopped */
      }
      sendJson(response, 200, { ok: true, disconnected: true });
      return;
    }
    if (!ACTIONS.has(action)) {
      sendJson(response, 400, { ok: false, error: `unknown action "${action}"` });
      return;
    }
    const result = await tools.callTool('linkr_computer_use', body, {});
    if (result?.isError === true) {
      const text = (result.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join(' ');
      sendJson(response, 400, { ok: false, error: text === '' ? 'input failed' : text });
      return;
    }
    sendJson(response, 200, { ok: true, value: result?.value ?? {} });
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${host}`);
      const path = url.pathname;
      // The page and its static assets are tokenless: the browser loads them
      // with relative URLs (a <link>/<script> cannot carry the query string),
      // and they contain no device data. Everything that can read the device or
      // send input still requires the token.
      if (request.method === 'GET' && ASSETS.has(path)) {
        const [file, type] = ASSETS.get(path);
        const body = await readFile(join(HERE, file));
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length });
        response.end(body);
        return;
      }
      if (url.searchParams.get('t') !== tokenValue) {
        sendJson(response, 403, { ok: false, error: 'bad token' });
        return;
      }
      if (request.method === 'GET' && path === '/stream') {
        await handleStream(request, response);
        return;
      }
      if (request.method === 'GET' && path === '/frame.jpg') {
        await handleSnapshot(response);
        return;
      }
      if (request.method === 'GET' && path === '/state.json') {
        sendJson(response, 200, panelState());
        return;
      }
      if (request.method === 'POST' && path === '/input.json') {
        await handleInput(request, response);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
      else response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const panelUrl = `http://${host}:${address.port}/?t=${tokenValue}`;

  return {
    url: panelUrl,
    token: tokenValue,
    get subscribers() {
      return subscribers.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const response of subscribers) {
        try {
          response.end();
        } catch {
          /* already gone */
        }
      }
      subscribers.clear();
      unwatchFramesIfIdle();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
