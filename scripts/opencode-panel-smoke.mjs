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
let stopped = false;
const stub = {
  async callTool(name, args = {}) {
    calls.push({ name, args });
    if (name === 'linkr_computer_use' && args.action === 'capture') {
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
    return { state: { connected: true, codec: 'h264', width: 2, height: 2, fps: 10 }, activity: [{ at: Date.now(), action: '截图', detail: '2×2' }] };
  },
  async stop() {
    stopped = true;
  },
};

const server = await createPanelServer({ tools: stub, fps: 30 });

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
