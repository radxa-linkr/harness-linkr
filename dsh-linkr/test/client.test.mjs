/**
 * LinkrClient against the fake device: capture, HID bytes on the wire, video-mode
 * switch + restore, idle stop, dispose and the failure paths (CONTRACT.md §2.3–2.5).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LinkrClient, LinkrError } from '../lib/index.js';
import { encodeKey, encodeMouse, parseCombo } from '../lib/hid.js';
import { createFakeDevice } from './fake-device.mjs';

const USER = 'tester';
const PASS = 's3cret';
const CAMERA = { width: 640, height: 360 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

function compact(text) {
  return text.replace(/\s+/g, '').toLowerCase();
}

const HALF = '00 00 00 00 00 00 e0 3f';
const ZERO = '00 00 00 00 00 00 00 00';

/** Hand-written mouse frame, same derivation as test/hid.test.mjs. */
function mouseHex(type, buttons) {
  return compact(`
    02
    08 0${type}
    10 0${buttons}
    19 ${HALF}
    21 ${HALF}
    29 ${ZERO}
    31 ${ZERO}
  `);
}

const MOVE_HEX = mouseHex(1, 0);
const DOWN_HEX = mouseHex(2, 1);
const UP_HEX = mouseHex(4, 0);

const KEY_A_DOWN = compact('01 08 01 12 01 61 1a 04 4b 65 79 41');
const KEY_A_UP = compact('01 08 00 12 01 61 1a 04 4b 65 79 41');

async function withClient(t, clientOptions = {}, fakeOptions = {}) {
  const fake = createFakeDevice(fakeOptions);
  const origin = await fake.listen();
  const client = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    // These tests exercise the MJPEG pipeline; the H.264 path has its own file.
    codec: 'mjpeg',
    ...clientOptions,
  });
  t.after(async () => {
    await client.dispose();
    await fake.close();
  });
  return { fake, client, origin };
}

function hidHex(frames) {
  return frames.map((frame) => Buffer.from(frame).toString('hex'));
}

test('connect + capture returns a JPEG with the device pixel size', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();

  const state = client.state;
  assert.equal(state.connected, true);
  assert.equal(state.configured, true);
  assert.equal(state.videoMode, 1);
  assert.equal(state.modeOwned, true);
  assert.equal(state.device?.deviceName, 'Fake Linkr');
  assert.equal(state.device?.sn, 'FAKE-0001');

  const frame = await client.capture();
  assert.ok(Buffer.isBuffer(frame.jpeg));
  assert.equal(frame.jpeg[0], 0xff);
  assert.equal(frame.jpeg[1], 0xd8);
  assert.equal(frame.width, CAMERA.width);
  assert.equal(frame.height, CAMERA.height);
  assert.ok(frame.at > 0);
  assert.ok(frame.seq > 0);

  // capture() asks for a *fresh* frame, not the one connect() already used.
  const second = await client.capture();
  assert.ok(second.seq > frame.seq);
  assert.equal(fake.openMediaSockets, 1);
});

test('state stays plain JSON', async (t) => {
  const { client } = await withClient(t);
  await client.connect();
  await client.capture();
  const json = JSON.parse(JSON.stringify(client.state));
  assert.deepEqual(Object.keys(json).sort(), [
    'codec',
    'configured',
    'connected',
    'decoder',
    'device',
    'error',
    'fps',
    'frames',
    'height',
    'lastFrameAt',
    'modeOwned',
    'notice',
    'origin',
    'videoMode',
    'width',
  ]);
  assert.equal(json.connected, true);
  assert.equal(typeof json.frames, 'number');
  assert.equal(json.codec, 'mjpeg');
  assert.equal(json.decoder, null);
});

test('the video mode is written to 1 and restored on disconnect', async (t) => {
  const { client, fake } = await withClient(t, {}, { initialCodec: 0 });
  assert.equal(fake.codec, 0);

  await client.connect();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1]);
  assert.equal(client.state.videoMode, 1);

  await client.disconnect();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 0]);
  assert.equal(fake.codec, 0);
  assert.equal(client.state.connected, false);
  assert.equal(client.state.modeOwned, false);
  assert.equal(client.state.videoMode, 0);
  await until(() => fake.openMediaSockets === 0, 2000, 'media socket to close');
});

test('dispose restores the video mode too', async (t) => {
  const fake = createFakeDevice({ initialCodec: 2 });
  const origin = await fake.listen();
  const client = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
  });
  t.after(async () => {
    await fake.close();
  });

  await client.connect();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1]);
  await client.dispose();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 2]);
  assert.equal(fake.codec, 2, 'the original H.264 mode came back');
  await until(() => fake.openMediaSockets === 0, 2000, 'media socket to close');
});

test('a device already in MJPEG is left alone', async (t) => {
  const { client, fake } = await withClient(t, {}, { initialCodec: 1 });
  await client.connect();
  assert.equal(client.state.modeOwned, false);
  await client.disconnect();
  assert.deepEqual(fake.codecWrites, []);
  assert.equal(fake.codec, 1);
});

test('manageVideoMode:false refuses a non-MJPEG device with a clear sentence', async (t) => {
  const { client, fake } = await withClient(t, { manageVideoMode: false }, { initialCodec: 0 });
  await assert.rejects(client.connect(), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.match(error.sentence, /manageVideoMode/);
    assert.match(error.sentence, /MJPEG/);
    return true;
  });
  assert.deepEqual(fake.codecWrites, [], 'never writes the device setting');
  assert.equal(fake.openMediaSockets, 0);
});

test('manageVideoMode:false works when the device is already MJPEG', async (t) => {
  const { client, fake } = await withClient(t, { manageVideoMode: false }, { initialCodec: 1 });
  await client.connect();
  const frame = await client.capture();
  assert.equal(frame.width, CAMERA.width);
  assert.deepEqual(fake.codecWrites, []);
});

test('idleStopMs stops the session and gives the mode back', async (t) => {
  const { client, fake } = await withClient(t, { idleStopMs: 150 }, { initialCodec: 0 });
  await client.connect();
  assert.equal(client.state.connected, true);

  await until(() => client.state.connected === false, 3000, 'the idle stop');
  await until(() => fake.codecWrites.length === 2, 2000, 'the mode restore');
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 0]);
  assert.equal(fake.codec, 0);
  assert.equal(client.state.error, '', 'an idle stop is not an error');

  // Any call revives it: capture() dials again and the mode is owed anew.
  const frame = await client.capture({ timeoutMs: 8000 });
  assert.equal(frame.width, CAMERA.width);
  await until(() => fake.codecWrites.length === 3, 2000, 'the second switch');
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 0, 1]);
});

test('click reaches the socket as move + down + up, byte for byte', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();
  fake.hidFrames.length = 0;

  const result = await client.input({ kind: 'mouse', action: 'click', x: 0.5, y: 0.5 });
  assert.equal(result.applied, 'mouse');
  assert.equal(result.detail.action, 'click');

  await fake.waitForHid(3);
  assert.deepEqual(hidHex(fake.hidFrames.slice(0, 3)), [MOVE_HEX, DOWN_HEX, UP_HEX]);
});

test('mouse move, wheel and drag produce the documented frames', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();
  fake.hidFrames.length = 0;

  await client.input({ kind: 'mouse', action: 'move', x: 0.5, y: 0.5 });
  await fake.waitForHid(1);
  assert.deepEqual(hidHex(fake.hidFrames.slice(0, 1)), [MOVE_HEX]);

  fake.hidFrames.length = 0;
  await client.input({ kind: 'mouse', action: 'scroll', wheelY: -1 });
  await fake.waitForHid(1);
  assert.deepEqual(hidHex(fake.hidFrames.slice(0, 1)), [
    compact(`
      02 08 03 10 00
      19 ${HALF} 21 ${HALF} 29 ${ZERO} 31 ${ZERO}
      38 ff ff ff ff ff ff ff ff ff 01
    `),
  ]);

  fake.hidFrames.length = 0;
  await client.input({ kind: 'mouse', action: 'drag', x: 0.1, y: 0.1, toX: 0.9, toY: 0.9 });
  await fake.waitForHid(7);
  const frames = fake.hidFrames.slice(0, 7);
  // [move, down, 4 interpolation moves, up]
  assert.deepEqual(frames.map((frame) => frame[2]), [1, 2, 1, 1, 1, 1, 4]);
  assert.equal(frames[1][4], 1, 'the drag presses the left button');
  assert.equal(frames[6][4], 0, 'and lifts it at the target');
  // layout: [02][08 type][10 buttons][19 absX][21 absY][29 relX][31 relY]
  assert.equal(frames[6].readDoubleLE(6), 0.9, 'last absX is the drag target');
  assert.equal(frames[6].readDoubleLE(15), 0.9, 'last absY is the drag target');
});

test('a key combo is sent in order, pressed and released', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();
  fake.hidFrames.length = 0;

  await client.input({ kind: 'key', combo: 'ctrl+shift+t' });
  const expected = parseCombo('ctrl+shift+t').map((event) =>
    Buffer.from(encodeKey(event)).toString('hex'),
  );
  await fake.waitForHid(expected.length);
  assert.deepEqual(hidHex(fake.hidFrames.slice(0, expected.length)), expected);
});

test('text types real key events when the paste fast path is off', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();
  fake.hidFrames.length = 0;

  const result = await client.input({ kind: 'text', text: 'a' });
  assert.equal(result.applied, 'text');
  assert.equal(result.detail.via, 'keys');
  await fake.waitForHid(2);
  assert.deepEqual(hidHex(fake.hidFrames.slice(0, 2)), [KEY_A_DOWN, KEY_A_UP]);
  assert.deepEqual(fake.pastes, []);
});

test('text rejects a character the device cannot type before touching the socket', async (t) => {
  const { client, fake } = await withClient(t);
  await client.connect();
  fake.hidFrames.length = 0;
  await assert.rejects(client.input({ kind: 'text', text: '你好' }), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.match(error.sentence, /你/);
    assert.match(error.sentence, /Linkrd/);
    return true;
  });
  await sleep(60);
  assert.deepEqual(fake.hidFrames, []);
});

test('the opt-in paste fast path is used when enabled, and falls back when refused', async (t) => {
  const { client, fake } = await withClient(t, { pasteFastPath: true });
  await client.connect();

  const pasted = await client.input({ kind: 'text', text: 'hi there' });
  assert.equal(pasted.detail.via, 'paste');
  assert.deepEqual(fake.pastes, ['hi there']);
  assert.deepEqual(fake.hidFrames, []);

  // Now a device that refuses paste: the session falls back to key events.
  const failing = createFakeDevice({ pasteFails: true });
  const origin = await failing.listen();
  const fallback = new LinkrClient({
    baseUrl: origin,
    username: USER,
    password: PASS,
    pasteFastPath: true,
  });
  t.after(async () => {
    await fallback.dispose();
    await failing.close();
  });
  await fallback.connect();
  const typed = await fallback.input({ kind: 'text', text: 'a' });
  assert.equal(typed.detail.via, 'keys');
  await failing.waitForHid(2);
  assert.deepEqual(hidHex(failing.hidFrames.slice(0, 2)), [KEY_A_DOWN, KEY_A_UP]);
});

test('input without a session is a clear error, not a silent no-op', async (t) => {
  const { client } = await withClient(t);
  await assert.rejects(
    client.input({ kind: 'mouse', action: 'move', x: 0.5, y: 0.5 }),
    (error) => {
      assert.ok(error instanceof LinkrError);
      assert.equal(error.sentence, 'no live session; call linkr_status/linkr_connect first');
      return true;
    },
  );
});

test('concurrent connect() calls share one negotiation', async (t) => {
  const { client, fake } = await withClient(t);
  await Promise.all([client.connect(), client.connect(), client.connect()]);
  assert.equal(fake.whepCalls, 1);
  assert.equal(fake.openMediaSockets, 1);
});

test('a dropped media socket is reported and still restores the video mode', async (t) => {
  const { client, fake } = await withClient(t, {}, { initialCodec: 0 });
  await client.connect();
  assert.equal(client.state.connected, true);

  fake.dropMediaSockets();
  await until(() => client.state.connected === false, 3000, 'the socket to close');
  assert.match(client.state.error, /media socket/);
  await until(() => fake.codecWrites.length === 2, 2000, 'the mode restore');
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 0]);
});

test('probe reports identity and video mode without writing the setting', async (t) => {
  const { client, fake } = await withClient(t, {}, { initialCodec: 0 });
  const probe = await client.probe();
  assert.equal(probe.device.deviceName, 'Fake Linkr');
  assert.equal(probe.device.model, 'Radxa Linkr (fake)');
  assert.equal(probe.videoMode, 0);
  assert.deepEqual(fake.codecWrites, []);
});

test('configure() drops a live session and restores the mode first', async (t) => {
  const { client, fake } = await withClient(t, {}, { initialCodec: 0 });
  await client.connect();
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1]);

  await client.configure({ fps: 5 });
  assert.equal(client.state.connected, false);
  assert.deepEqual(fake.codecWrites.map((w) => w.video_codec), [1, 0]);
  assert.equal(fake.codec, 0);
});

test('capture after dispose fails instead of hanging', async (t) => {
  const { client } = await withClient(t);
  await client.connect();
  await client.dispose();
  await assert.rejects(client.capture(), LinkrError);
});
