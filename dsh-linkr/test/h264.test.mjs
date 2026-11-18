/**
 * H.264 over the media socket (CONTRACT.md §7): ws-media packets → one ffmpeg
 * child → JPEG frames in the same onFrame/latest/waitFrame pipeline.
 *
 * The clip is generated with the local ffmpeg; when ffmpeg is absent every test
 * here skips cleanly (the MJPEG suite still covers the rest).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findFfmpeg } from '../lib/ffmpeg.js';
import { MediaSession } from '../lib/media.js';
import { LinkrDevice } from '../lib/linkr.js';
import { LinkrClient } from '../lib/index.js';
import { createFakeDevice } from './fake-device.mjs';

const FFMPEG = findFfmpeg();
const gate = FFMPEG ? false : 'ffmpeg not found; H.264 integration tests skipped';
const USER = 'tester';
const PASS = 's3cret';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

/** A runnable "ffmpeg" that exits immediately (simulates a broken decoder). */
function brokenFfmpeg(t) {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-broken-ffmpeg-'));
  const file = join(dir, 'ffmpeg');
  writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  chmodSync(file, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

/** A 2 s, 320x180, 15 fps AnnexB clip made by the local ffmpeg (cached). */
let clipCache = null;
function h264Clip() {
  if (clipCache) return clipCache;
  const result = spawnSync(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=15:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'h264',
      'pipe:1',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
    throw new Error(`could not generate the H.264 clip: ${String(result.stderr ?? '').slice(0, 300)}`);
  }
  clipCache = result.stdout;
  return clipCache;
}

test('H.264: ws_h264 packets decode into frames for capture()', { skip: gate }, async (t) => {
  const clip = h264Clip();
  assert.equal(clip.subarray(0, 4).toString('hex'), '00000001', 'clip is AnnexB');

  const fake = createFakeDevice({ initialCodec: 0, h264Clip: clip });
  const origin = await fake.listen();
  const client = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    codec: 'h264',
    ffmpegPath: FFMPEG,
    jpegQuality: 5,
  });
  t.after(async () => {
    await client.dispose();
    await fake.close();
  });

  await client.connect();
  assert.equal(client.state.codec, 'h264');
  assert.equal(client.state.decoder, 'ffmpeg');
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [2], 'the device was put in H.264 mode');

  const frame = await client.capture({ timeoutMs: 10000 });
  assert.ok(Buffer.isBuffer(frame.jpeg));
  assert.equal(frame.jpeg[0], 0xff);
  assert.equal(frame.jpeg[1], 0xd8);
  assert.equal(frame.width, 320);
  assert.equal(frame.height, 180);

  const started = Date.now();
  let frames = 0;
  const off = client.onFrame(() => {
    frames += 1;
  });
  await sleep(1200);
  off();
  const seconds = (Date.now() - started) / 1000;
  const fps = frames / seconds;
  t.diagnostic(
    `decoded ${frames} frames in ${seconds.toFixed(2)} s => ${fps.toFixed(1)} fps ` +
      `from ${fake.packetsSent} ws_h264 packets`,
  );
  assert.ok(frames > 0, 'decoded frames arrived');
  assert.ok(fps >= 5, `expected at least 5 decoded fps, got ${fps.toFixed(1)}`);

  await client.disconnect();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [2, 0], 'the original mode came back');
  await until(() => fake.openMediaSockets === 0, 3000, 'the media socket to close');
});

test('H.264: input rides the same socket as the decoded video', { skip: gate }, async (t) => {
  const fake = createFakeDevice({ initialCodec: 2, h264Clip: h264Clip() });
  const origin = await fake.listen();
  const client = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    codec: 'h264',
    ffmpegPath: FFMPEG,
  });
  t.after(async () => {
    await client.dispose();
    await fake.close();
  });

  await client.connect();
  await client.capture({ timeoutMs: 10000 });
  fake.hidFrames.length = 0;
  await client.input({ kind: 'mouse', action: 'move', x: 0.25, y: 0.75 });
  await fake.waitForHid(1);
  assert.equal(fake.hidFrames[0][0], 2, 'a mouse frame reached the H.264 socket');
});

test('dispose kills the ffmpeg child and the media socket', { skip: gate }, async (t) => {
  const fake = createFakeDevice({ initialCodec: 2, h264Clip: h264Clip() });
  const origin = await fake.listen();
  const device = new LinkrDevice({ baseUrl: origin, username: USER, password: PASS });
  const session = new MediaSession(device, { codec: 'h264', ffmpegPath: FFMPEG, jpegQuality: 5 });
  t.after(async () => {
    device.dispose();
    await fake.close();
  });

  await session.start({ timeoutMs: 10000 });
  const pid = session.decoderPid;
  assert.ok(pid > 0, 'an ffmpeg child is running');

  session.stop();
  assert.equal(session.open, false, 'the media socket is closed');
  assert.equal(session.decoderPid, 0, 'the session dropped its child reference');

  await until(
    () => {
      try {
        process.kill(pid, 0);
        return false; // still alive
      } catch (error) {
        return error.code === 'ESRCH';
      }
    },
    5000,
    'the ffmpeg child to exit',
  );
  await until(() => fake.openMediaSockets === 0, 3000, 'the media socket to close');
});

test('a dead ffmpeg degrades to MJPEG once and says so', { skip: gate }, async (t) => {
  const broken = brokenFfmpeg(t);
  const fake = createFakeDevice({ initialCodec: 0, h264Clip: h264Clip() });
  const origin = await fake.listen();
  const client = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    codec: 'h264',
    ffmpegPath: broken,
  });
  t.after(async () => {
    await client.dispose();
    await fake.close();
  });

  await client.connect();
  assert.equal(client.state.codec, 'mjpeg', 'fell back to the MJPEG pipeline');
  assert.equal(client.state.decoder, null);
  assert.match(client.state.notice, /H\.264/);
  assert.match(client.state.notice, /MJPEG/);
  assert.deepEqual(
    fake.codecWrites.map((w) => w.video_codec),
    [2, 0, 1],
    'tried H.264 (2), restored the original (0), then switched to MJPEG (1)',
  );

  const frame = await client.capture({ timeoutMs: 10000 });
  assert.equal(frame.width, 640, 'MJPEG frames are the canned fake ones');
});

test('missing ffmpeg: auto uses MJPEG, explicit h264 degrades with a sentence', { skip: gate }, async (t) => {
  const fake = createFakeDevice({ initialCodec: 0, h264Clip: h264Clip() });
  const origin = await fake.listen();
  const previous = process.env.LINKR_NO_FFMPEG;
  process.env.LINKR_NO_FFMPEG = '1';
  const auto = new LinkrClient({ baseUrl: origin, username: USER, password: PASS, codec: 'auto' });
  const explicit = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    codec: 'h264',
  });
  t.after(async () => {
    await auto.dispose();
    await explicit.dispose();
    await fake.close();
    if (previous === undefined) delete process.env.LINKR_NO_FFMPEG;
    else process.env.LINKR_NO_FFMPEG = previous;
  });
  try {
    await auto.connect();
    assert.equal(auto.state.codec, 'mjpeg', 'auto never asks for H.264 without ffmpeg');
    assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1]);

    await explicit.connect();
    assert.equal(explicit.state.codec, 'mjpeg', 'explicit h264 degraded instead of crashing');
    assert.match(explicit.state.notice, /ffmpeg/i);
    const frame = await explicit.capture({ timeoutMs: 10000 });
    assert.equal(frame.width, 640);
  } finally {
    if (previous === undefined) delete process.env.LINKR_NO_FFMPEG;
    else process.env.LINKR_NO_FFMPEG = previous;
  }
});
