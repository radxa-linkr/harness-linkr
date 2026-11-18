/**
 * LinkrDevice against the fake device: login, envelope unwrapping, the one-time
 * 403 re-login, error shape (CONTRACT.md §2.1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LinkrDevice, LinkrError, hashPassword, normalizeOrigin } from '../lib/linkr.js';
import { createFakeDevice } from './fake-device.mjs';

const USER = 'tester';
const PASS = 's3cret';

async function withDevice(t, options = {}) {
  const fake = createFakeDevice(options);
  const origin = await fake.listen();
  const device = new LinkrDevice({ baseUrl: origin, username: USER, password: PASS });
  t.after(async () => {
    device.dispose();
    await fake.close();
  });
  return { fake, device, origin };
}

test('normalizeOrigin strips trailing slashes and defaults the scheme', () => {
  assert.equal(normalizeOrigin('http://linkr.local/'), 'http://linkr.local');
  assert.equal(normalizeOrigin('  http://linkr.local///  '), 'http://linkr.local');
  assert.equal(normalizeOrigin('linkr.local'), 'http://linkr.local');
  assert.equal(normalizeOrigin(''), '');
});

test('hashPassword is lowercase hex sha256 of salt + plaintext', () => {
  const hash = hashPassword('s3cret');
  assert.match(hash, /^[0-9a-f]{64}$/);
  // The fake device verifies the same value with its own implementation.
  assert.equal(hash, hashPassword('s3cret'));
  assert.notEqual(hash, hashPassword('s3cret '));
});

test('login returns a JWT-ish token and the username', async (t) => {
  const { fake, device } = await withDevice(t);
  const result = await device.login();
  assert.equal(result.username, USER);
  assert.match(result.token, /^fake-/);
  assert.equal(device.hasToken, true);
  assert.equal(fake.logins, 1);
});

test('login with the wrong password fails with 403 and one clear sentence', async (t) => {
  const fake = createFakeDevice();
  const origin = await fake.listen();
  const device = new LinkrDevice({ baseUrl: origin, username: USER, password: 'nope' });
  t.after(async () => {
    device.dispose();
    await fake.close();
  });
  await assert.rejects(device.login(), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.equal(error.status, 403);
    assert.equal(error.path, '/api/account/login');
    assert.match(error.sentence, /403/);
    assert.ok(!/\n/.test(error.sentence), 'sentence must be one line');
    return true;
  });
  assert.equal(fake.logins, 0);
});

test('unauthenticated calls work before login and unwrap the envelope', async (t) => {
  const { device } = await withDevice(t, { deviceName: 'Desk Linkr' });
  const info = await device.info();
  assert.equal(info.deviceName, 'Desk Linkr');
  assert.equal(info.status, 'online');
  assert.equal(typeof info.onlineTime, 'number');
});

test('deviceInfo and version use the Bearer token', async (t) => {
  const { device, fake } = await withDevice(t, { sn: 'SN-42', version: '9.9.9' });
  const hardware = await device.deviceInfo();
  const version = await device.version();
  assert.equal(hardware.sn, 'SN-42');
  assert.equal(version.version, '9.9.9');
  assert.equal(fake.logins, 1, 'the token is reused, not re-fetched per call');
});

test('a stale token is refreshed exactly once', async (t) => {
  const { device, fake } = await withDevice(t);
  await device.login();
  assert.equal(fake.logins, 1);

  fake.expireTokens(); // the device forgets the token: next authed call answers 403
  const hardware = await device.deviceInfo();
  assert.equal(hardware.sn, 'FAKE-0001');
  assert.equal(fake.logins, 2, 'one re-login, then the call is retried');
});

test('a second 403 is fatal and keeps status/code/path/sentence', async (t) => {
  const { device, fake } = await withDevice(t);
  await device.login();
  fake.expireTokens();
  // Force the retry to fail too by making the account unusable after the first 403.
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    fake.expireTokens();
    return originalFetch(...args);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(device.deviceInfo(), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 403);
    assert.equal(error.path, '/api/device/info');
    assert.match(error.sentence, /403/);
    return true;
  });
  assert.ok(calls >= 3, `expected login + retry + re-login attempts, saw ${calls}`);
});

test('videoMode reads and setVideoMode writes the device setting', async (t) => {
  const { device, fake } = await withDevice(t, { initialCodec: 0 });
  assert.equal(await device.videoMode(), 0);
  await device.setVideoMode(1);
  assert.equal(await device.videoMode(), 1);
  assert.deepEqual(
    fake.codecWrites.map((write) => write.video_codec),
    [1],
  );
});

test('whep in the wrong video mode keeps the device message', async (t) => {
  const { device } = await withDevice(t, { initialCodec: 0 });
  await assert.rejects(device.whep('ws_mjpeg'), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.equal(error.code, 1);
    assert.equal(error.path, '/api/rtc/whep');
    assert.match(error.sentence, /called Whep with error/);
    return true;
  });
});

test('whep in MJPEG mode returns a one-shot answer token', async (t) => {
  const { device, fake } = await withDevice(t, { initialCodec: 1 });
  const result = await device.whep('ws_mjpeg');
  assert.equal(typeof result.answer, 'string');
  assert.ok(result.answer.length > 0);
  assert.equal(result.streamId, '42');
  assert.equal(fake.whepCalls, 1);
});

test('paste posts the text and records it on the device', async (t) => {
  const { device, fake } = await withDevice(t);
  await device.paste('hello');
  assert.deepEqual(fake.pastes, ['hello']);
});

test('an unreachable device fails with a reachable sentence, not a stack', async (t) => {
  const device = new LinkrDevice({
    baseUrl: 'http://127.0.0.1:1',
    username: USER,
    password: PASS,
    timeoutMs: 500,
  });
  t.after(() => device.dispose());
  await assert.rejects(device.info(), (error) => {
    assert.ok(error instanceof LinkrError);
    assert.match(error.sentence, /cannot reach the Linkr device/);
    assert.ok(!/\n/.test(error.sentence));
    return true;
  });
});

test('LinkrError serializes without a stack', () => {
  const error = new LinkrError('boom', { status: 500, code: 7, path: '/x', sentence: 'it broke' });
  assert.deepEqual(error.toJSON(), {
    name: 'LinkrError',
    sentence: 'it broke',
    status: 500,
    code: 7,
    path: '/x',
    // A machine-readable cause for callers that must branch (the clipboard
    // probe's disabled / disconnected / unsupported), empty when there is none.
    reason: '',
  });
  assert.equal(error.message, 'it broke');
  assert.equal(new LinkrError('x', { reason: 'disabled' }).reason, 'disabled');
});
