#!/usr/bin/env node
/**
 * The Host manager can end a session that only a panel was keeping alive.
 * It must leave an agent-used session and an explicit Stop alone.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const scratch = mkdtempSync(join(tmpdir(), 'linkr-release-idle-'));
process.env.LINKR_STATE_DIR = scratch;

const { createFakeDevice } = await import('./fake-device.mjs');
const { createClientManager } = await import('../host/client.js');

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

const fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 0 });
const origin = await fake.listen();
const config = {
  baseUrl: origin,
  username: 'tester',
  password: 's3cret',
  codec: 'mjpeg',
  ffmpegPath: '/nonexistent-ffmpeg',
  jpegQuality: 4,
  manageVideoMode: true,
  streamFps: 5,
  idleStopMs: 0,
  screenshotDir: '',
};
const deps = {
  ctx: { get: () => undefined },
  config,
  activity: { setPassword() {}, record() {} },
  panel: { info: () => ({}) },
  explicitStop: false,
};
const manager = createClientManager(deps);

try {
  await check('an agent-used session is not released early', async () => {
    await manager.liveClient();
    assert.equal(fake.codec, 1);
    assert.equal(await manager.releaseIfIdle({ idleMs: 60000 }), false);
    assert.equal(fake.codec, 1);
  });

  await check('an idle session is disconnected and the mode restored', async () => {
    await sleep(150);
    assert.equal(await manager.releaseIfIdle({ idleMs: 100 }), true);
    assert.equal(fake.codec, 0);
    assert.equal((await manager.stateJson()).connected, false);
  });

  await check('an explicit Stop blocks the panel release', async () => {
    deps.explicitStop = true;
    await manager.liveClient();
    await sleep(150);
    assert.equal(await manager.releaseIfIdle({ idleMs: 100 }), false);
    assert.equal(fake.codec, 1);
    deps.explicitStop = false;
  });

  await check('POST connect owns the session until the last viewer leaves', async () => {
    await (await manager.currentClient()).disconnect();
    const { registerRoutes } = await import('../host/routes.js');
    const http = createServer();
    const unregister = registerRoutes({ webServer: { register({ handler }) {
      http.on('request', handler);
      return () => http.off('request', handler);
    } } }, { ...deps, client: manager }, { detachGraceMs: 100 });
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${http.address().port}/linkr`;
    const open = async () => {
      const controller = new AbortController();
      const response = await fetch(`${url}/live.mjpeg`, { signal: controller.signal });
      assert.equal(response.status, 200);
      return controller;
    };
    try {
      assert.equal((await fetch(`${url}/connect`, { method: 'POST' })).status, 200);
      const first = await open();
      const last = await open();
      first.abort();
      await sleep(200);
      assert.equal(fake.codec, 1, 'the remaining viewer still needs the stream');
      last.abort();
      const deadline = Date.now() + 2500;
      while (fake.codec !== 0 && Date.now() < deadline) await sleep(20);
      assert.equal(fake.codec, 0, 'last viewer departure restores the pre-session mode');
    } finally {
      unregister();
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
    }
  });
} finally {
  await manager.dispose().catch(() => {});
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
