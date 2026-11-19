/** MCP App resource, read-only video mirror, and separate private login/settings requests. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PANEL_URI } from './tools.js';
import { SettingsError } from './settings.js';

export const PANEL_RESOURCE = { uri: PANEL_URI, name: 'linkr-screen', title: 'Linkr 被控机画面', mimeType: 'text/html;profile=mcp-app' };

export function createPanelBridge(tools, { changeSettings = task => task(new AbortController().signal) } = {}) {
  const token = randomBytes(32).toString('hex');
  const writeToken = randomBytes(32).toString('hex');
  const streams = new Set();
  let server;
  let starting;
  let origin;
  let closed = false;
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  function stream(req, res) {
    if (!tools.panelState().state.connected) return json(res, 409, { error: 'screen session is stopped' });
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=linkrframe', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    let pending = tools.latest();
    const revision = tools.panelState().revision;
    let blocked = false;
    let ended = false;
    const unsubscribe = tools.onFrame(frame => { pending = frame; });
    const stop = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer); unsubscribe(); streams.delete(stop); res.end();
    };
    const interval = Math.round(1000 / Math.max(1, Math.min(60, tools.settings().streamFps)));
    const timer = setInterval(() => {
      if (!tools.panelState().state.connected || tools.panelState().revision !== revision) { stop(); return; }
      tools.keepAlive();
      if (blocked || !pending) return;
      const frame = pending;
      pending = null;
      const header = Buffer.from(`--linkrframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.jpeg.length}\r\n\r\n`);
      // One write per frame; backpressure keeps only the newest frame in memory.
      blocked = !res.write(Buffer.concat([header, frame.jpeg, Buffer.from('\r\n')]));
    }, interval);
    res.on('drain', () => { blocked = false; });
    res.on('close', stop);
    streams.add(stop);
  }
  async function start() {
    if (closed) throw new Error('Linkr panel bridge is closed');
    if (origin) return;
    if (starting) return starting;
    starting = (async () => {
      server = createServer((req, res) => { void handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { ok: false, error: '本机 Linkr 服务暂不可用，请重试。' });
        else res.end();
      }); });
      async function handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const parts = url.pathname.split('/');
        const supplied = Buffer.from(parts[1] ?? '');
        const expected = Buffer.from(token);
        if (req.headers.host !== origin?.slice(7) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          json(res, 403, { error: 'invalid panel capability' }); return;
        }
        // Separate write capability is sent only in App _meta and a request header, never an image URL.
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Linkr-Panel-Token');
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
          res.writeHead(204); res.end(); return;
        }
        if (req.method === 'POST' && ['settings', 'logout'].includes(parts[2])) {
          const suppliedWrite = Buffer.from(req.headers['x-linkr-panel-token'] || '');
          const expectedWrite = Buffer.from(writeToken);
          if (suppliedWrite.length !== expectedWrite.length || !timingSafeEqual(suppliedWrite, expectedWrite)) {
            json(res, 403, { ok: false, error: '登录设置授权已失效，请重新打开面板。' }); return;
          }
          if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') { json(res, 415, { ok: false, error: '请使用 JSON 登录设置。' }); return; }
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 32768) { json(res, 413, { ok: false, error: '登录设置过长。' }); return; }
            chunks.push(chunk);
          }
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { json(res, 400, { ok: false, error: '登录设置格式不正确。' }); return; }
          const end = tools.beginConfiguration();
          try {
            const result = await changeSettings(signal => parts[2] === 'logout' ? tools.logout({ signal }) : tools.saveSettings(value, { signal }));
            json(res, 200, result);
          } catch (error) {
            json(res, error instanceof SettingsError ? error.status : 409, { ok: false,
              error: error instanceof SettingsError ? error.message : '操作已取消，请查看当前连接状态。',
              ...tools.panelState(), settings: tools.settings() });
          } finally { end(); }
          return;
        }
        if (req.method !== 'GET') { json(res, 405, { error: 'read-only endpoint' }); return; }
        if (parts[2] === 'status.json') {
          const frame = tools.latest();
          json(res, 200, { ...tools.panelState(), frameAt: frame?.at ?? 0 });
        } else if (parts[2] === 'live.mjpeg') stream(req, res);
        else if (parts[2] === 'settings.json') json(res, 200, tools.settings());
        else if (parts[2] === 'clipboard.json') json(res, 200, await tools.clipboardSnapshot());
        else if (parts[2] === 'frame.jpg') {
          const frame = tools.latest();
          if (!frame || !tools.panelState().state.connected) { json(res, 409, { error: 'no live frame' }); return; }
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); res.end(frame.jpeg);
        } else json(res, 404, { error: 'not found' });
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      server.unref();
    })().finally(() => { starting = null; });
    return starting;
  }
  async function metadata() {
    await start();
    return { linkr: { previewUrl: `${origin}/${token}/`, settingsToken: writeToken, transport: 'loopback-mjpeg' } };
  }
  async function resource() {
    await start();
    const [html, script, css] = await Promise.all(['index.html', 'app.js', 'style.css'].map(name => readFile(new URL(`./panel/${name}`, import.meta.url), 'utf8')));
    return { contents: [{ ...PANEL_RESOURCE, text: html.replace('/* LINKR_STYLE */', css).replace('/* LINKR_SCRIPT */', () => script),
      _meta: { ui: { csp: { connectDomains: [origin], resourceDomains: [origin] }, prefersBorder: false },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' } } }] };
  }
  async function close() {
    closed = true;
    await starting?.catch(() => {});
    for (const stop of [...streams]) stop();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  return { metadata, resource, close };
}
