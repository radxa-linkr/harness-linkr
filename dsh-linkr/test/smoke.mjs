/**
 * Real-device smoke test — OPT-IN, never part of the normal suite.
 *
 *   LINKR_SMOKE=1 LINKR_PASSWORD=... node --test test/smoke.mjs
 *
 * Optional: LINKR_BASE (default http://linkr.local), LINKR_USER (default admin),
 * LINKR_CODEC (auto | mjpeg | h264, default auto — with ffmpeg installed that
 * exercises the H.264 decode path and prints the measured decode rate).
 * The password is only ever read from the environment; it is not written here.
 *
 * What it proves: login, device probe, a real MJPEG capture (1920x1080), one mouse
 * move, and — most importantly — that the device video mode is back to the value it
 * had before the test. The smoke also restores it by hand if the client failed to,
 * because the device is somebody's desktop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LinkrClient } from '../lib/index.js';
import { LinkrDevice } from '../lib/linkr.js';

const enabled = process.env.LINKR_SMOKE === '1';
const BASE = process.env.LINKR_BASE ?? 'http://linkr.local';
const USER = process.env.LINKR_USER ?? 'admin';
const PASSWORD = process.env.LINKR_PASSWORD ?? '';
const CODEC = process.env.LINKR_CODEC ?? 'auto';

const skip = !enabled
  ? 'set LINKR_SMOKE=1 to run against a real Linkr device'
  : !PASSWORD
    ? 'set LINKR_PASSWORD to run against a real Linkr device'
    : false;

test('real device: login, probe, capture, mouse move, video mode restored', { skip }, async (t) => {
  const device = new LinkrDevice({ baseUrl: BASE, username: USER, password: PASSWORD });
  const before = { mode: null };
  let restored = null;
  const client = new LinkrClient({
    baseUrl: BASE,
    username: USER,
    password: PASSWORD,
    codec: CODEC,
    idleStopMs: 60000,
    fps: 20,
  });

  try {
    await device.login();
    before.mode = await device.videoMode();
    t.diagnostic(`device ${BASE} starts in video mode ${before.mode}`);

    const probe = await client.probe();
    t.diagnostic(
      `probe: ${probe.device.deviceName} · ${probe.device.model} · fw ${probe.device.version} · sn ${probe.device.sn}`,
    );
    assert.equal(typeof probe.device.deviceName, 'string');
    assert.ok(probe.device.deviceName.length > 0);

    const frame = await client.capture({ timeoutMs: 10000 });
    assert.ok(Buffer.isBuffer(frame.jpeg), 'capture returns a Buffer');
    assert.equal(frame.jpeg[0], 0xff);
    assert.equal(frame.jpeg[1], 0xd8);
    assert.ok(frame.jpeg.length > 1000, `frame is ${frame.jpeg.length} bytes`);
    t.diagnostic(
      `capture: ${frame.width}x${frame.height}, ${frame.jpeg.length} bytes, seq ${frame.seq}`,
    );
    t.diagnostic(
      `codec: ${client.state.codec} (${client.state.decoder ?? 'device JPEG'}) · state.fps: ${client.state.fps}`,
    );
    assert.equal(frame.width, 1920, 'the controlled host is 1920 wide');
    assert.equal(frame.height, 1080, 'the controlled host is 1080 tall');
    assert.equal(client.state.connected, true);
    assert.equal(client.state.modeOwned, true, 'the client switched to MJPEG and owes a restore');

    const moved = await client.input({ kind: 'mouse', action: 'move', x: 0.5, y: 0.5 });
    assert.equal(moved.applied, 'mouse');
    t.diagnostic('mouse move to the middle of the frame sent');
  } finally {
    // Cleanup never masks the real failure: it reports, restores, and lets the
    // original error (if any) propagate out of the finally block.
    try {
      await client.dispose();
    } catch (error) {
      t.diagnostic(`client.dispose failed: ${error.message}`);
    }
    try {
      restored = await device.videoMode();
    } catch (error) {
      t.diagnostic(`could not read the video mode after dispose: ${error.message}`);
    }
    if (before.mode !== null && restored !== null && restored !== before.mode) {
      // Last-resort restore: the client should never leave this debt behind.
      await device.setVideoMode(before.mode);
      restored = await device.videoMode();
      t.diagnostic(`!! client did not restore the mode; restored ${before.mode} by hand`);
    }
    t.diagnostic(`device video mode after dispose: ${restored}`);
    device.dispose();
  }

  assert.equal(restored, before.mode, 'the device video mode is back to its starting value');
});
