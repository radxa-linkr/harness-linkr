#!/usr/bin/env node
/**
 * Smoke check for the native plugin's web panel (`opencode/plugin/panel-server.js`).
 *
 * The server only depends on the Linkr tools interface (`callTool`, `onFrame`,
 * `panelState`, `stop`), so this drives it with a stub: no device, no
 * node_modules and no OpenCode needed. It exercises the token gate, the page
 * assets, the MJPEG stream, the JSON state/activity and the input endpoint.
 *
 *   node scripts/opencode-panel-smoke.mjs
 */

import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createPanelServer } = await import(pathToFileURL(join(ROOT, 'opencode', 'plugin', 'panel-server.js')).href);

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
let frames = [];
let calls = [];
let keepAliveCalls = 0;
let stopped = false;
let connected = false;
let released = 0;
const stub = {
  async callTool(name, args = {}) {
    calls.push({ name, args });
    if (name === 'linkr_computer_use' && args.action === 'capture') {
      connected = true;
      return { content: [{ type: 'text', text: 'captured 2x2' }], value: { path: '', width: 2, height: 2 } };
    }
    return { content: [{ type: 'text', text: 'ok' }], value: { ok: true } };
  },
  onFrame(listener) {
    frames.push(listener);
    return () => {
      frames = frames.filter((entry) => entry !== listener);
    };
  },
  panelState() {
    return { state: { connected, codec: 'h264', width: 2, height: 2, fps: 10 }, activity: [{ at: Date.now(), action: '截图', detail: '2×2' }] };
  },
  keepAlive() {
    keepAliveCalls += 1;
  },
  async releaseIfIdle() {
    released += 1;
    connected = false;
    return true;
  },
  async stop() {
    stopped = true;
  },
};

const server = await createPanelServer({ tools: stub, fps: 30, detachGraceMs: 200 });

await check('the page and its static assets load without a token', async () => {
  const bare = server.url.split('?')[0];
  const page = await fetch(bare);
  assert.equal(page.status, 200, 'the page must load without ?t=');
  const html = await page.text();
  assert.match(html, /Linkr 共享电脑/);
  for (const asset of ['/panel.css', '/panel.js']) {
    const response = await fetch(new URL(asset, server.url));
    assert.equal(response.status, 200, `${asset} status ${response.status}`);
    assert.ok((await response.text()).length > 100);
  }
});

await check('data endpoints require the token', async () => {
  for (const path of ['/state.json', '/frame.jpg']) {
    const response = await fetch(new URL(path, server.url));
    assert.equal(response.status, 403, `${path} status ${response.status}`);
  }
  const stream = await fetch(new URL('/stream', server.url));
  assert.equal(stream.status, 403);
  await stream.body?.cancel();
});

await check('the MJPEG stream starts a session and carries JPEG frames', async () => {
  const controller = new AbortController();
  const streamUrl = new URL('/stream?t=' + server.token, server.url);
  const response = await fetch(streamUrl, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /multipart\/x-mixed-replace/);
  assert.equal(calls.filter((call) => call.name === 'linkr_computer_use' && call.args.action === 'capture').length >= 1, true, 'capture must open the session');
  assert.ok(frames.length >= 1, 'the server must listen for frames');
  setTimeout(() => {
    for (const listener of [...frames]) listener({ jpeg: JPEG, width: 2, height: 2, at: Date.now(), seq: 1 });
  }, 20);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const text = Buffer.from(value.buffer ?? value).toString('latin1');
  assert.match(text, /Content-Type: image\/jpeg/);
  assert.ok(Buffer.from(value.buffer ?? value).includes(JPEG), 'the frame bytes must be in the part');
  assert.ok(keepAliveCalls >= 1, 'a mounted viewer must keep the idle session alive');
});

await check('state reports the session and recent activity', async () => {
  const response = await fetch(new URL('/state.json?t=' + server.token, server.url));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.state.connected, true);
  assert.equal(payload.state.codec, 'h264');
  assert.equal(payload.state.width, 2);
  assert.equal(payload.activity.length, 1);
  assert.equal(payload.activity[0].action, '截图');
});

await check('input is forwarded to the Linkr tools', async () => {
  const response = await fetch(new URL('/input.json?t=' + server.token, server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'move', x: 0.5, y: 0.5 }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  const last = calls.at(-1);
  assert.equal(last.name, 'linkr_computer_use');
  assert.equal(last.args.action, 'move');
});

await check('closing the last viewer releases a panel-started session', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(released, 1, 'one release after the detach grace');
  assert.equal(connected, false, 'the panel-started session is gone');
});

await check('disconnect calls stop; close releases the server', async () => {
  const response = await fetch(new URL('/input.json?t=' + server.token, server.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'disconnect' }),
  });
  assert.equal(response.status, 200);
  assert.equal(stopped, true);
  await server.close();
  await assert.rejects(fetch(server.url));
});

await check('a failed session surfaces its sentence in /state.json', async () => {
  const failing = {
    async callTool() {
      return { content: [{ type: 'text', text: 'another local Linkr session holds the device lease' }], isError: true };
    },
    onFrame() {
      return () => {};
    },
    panelState() {
      return { state: { connected: false }, activity: [] };
    },
    async stop() {},
  };
  const failingServer = await createPanelServer({ tools: failing, fps: 10 });
  const controller = new AbortController();
  const stream = await fetch(new URL('/stream?t=' + failingServer.token, failingServer.url), { signal: controller.signal });
  const reader = stream.body.getReader();
  const first = await reader.read();
  controller.abort();
  assert.match(Buffer.from(first.value ?? '').toString('latin1'), /device lease/);
  const state = await (await fetch(new URL('/state.json?t=' + failingServer.token, failingServer.url))).json();
  assert.match(state.error, /device lease/);
  assert.equal(state.state.connected, false);
  await failingServer.close();
});

await check('a viewer that leaves during connection is removed and the session released', async () => {
  let finish;
  const startup = new Promise(resolve => { finish = resolve; });
  let released;
  const release = new Promise(resolve => { released = resolve; });
  let connected = false;
  let listeners = 0;
  const panel = await createPanelServer({ detachGraceMs: 20, tools: {
    async callTool() { await startup; connected = true; return {}; },
    panelState: () => ({ state: { connected } }),
    onFrame() { listeners++; return () => { listeners--; }; },
    async releaseIfIdle() { connected = false; released(); return true; },
  } });
  const status = () => fetch(new URL('/state.json?t=' + panel.token, panel.url)).then(res => res.json());
  const signal = AbortSignal.timeout(3000);
  const controller = new AbortController();
  try {
    await fetch(new URL('/stream?t=' + panel.token, panel.url), { signal: controller.signal });
    controller.abort();
    while ((await status()).state.subscribers !== 0) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    finish();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('aborted startup session was not released')), 1000);
      release.then(() => { clearTimeout(timer); resolve(); });
    });
    assert.equal(listeners, 0);
    assert.equal((await status()).state.subscribers, 0);
  } finally {
    controller.abort();
    finish();
    await panel.close();
  }
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
