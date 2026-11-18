import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFakeDevice } from '../../dsh-linkr/test/fake-device.mjs';
import { hashPassword } from '../../dsh-linkr/lib/linkr.js';
import { readConfig } from '../config.js';
import { startMcp } from './rpc-client.mjs';

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'linkr-private-login-'));
  const configFile = join(scratch, 'config.json');
  const logFile = join(scratch, 'mcp.log');
  const env = { LINKR_BASE_URL: '', LINKR_USERNAME: '', LINKR_PASSWORD: '', LINKR_PASSWORD_FILE: '', LINKR_CREDENTIALS_FILE: '', LINKR_CODEC: '',
    LINKR_CONFIG_FILE: configFile, LINKR_STATE_DIR: join(scratch, 'state'), LINKR_SAVE_DIR: join(scratch, 'captures'), LINKR_MCP_LOG_FILE: logFile };
  const clients = [], devices = [];
  t.after(async () => { for (const c of clients) await c.close(); for (const d of devices) await d.close(); await rm(scratch, { recursive: true, force: true }); });
  async function device(options = {}) { const d = createFakeDevice(options); devices.push(d); await d.listen(); return d; }
  async function start() {
    const c = startMcp(env); clients.push(c);
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'login-regression', version: '1' } }).result;
    const open = await c.tool('linkr_panel').result;
    const { previewUrl, settingsToken } = open._meta.linkr;
    const post = (body, path = 'settings', token = settingsToken) => fetch(previewUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Linkr-Panel-Token': token }, body: JSON.stringify(body) });
    const get = path => fetch(previewUrl + path).then(r => r.json());
    return { c, post, get, previewUrl, settingsToken };
  }
  const body = (d, password = d.config.password) => ({ baseUrl: d.origin, username: d.config.username, password, codec: 'mjpeg', streamFps: 20, jpegQuality: 4, ffmpegPath: '' });
  return { scratch, configFile, logFile, env, device, start, body };
}

test('login uses a separate write capability; GET and MCP output never echo a password', async t => {
  const f = await fixture(t); const d = await f.device({ username: '测试账户', password: '回归密码-123' }); const panel = await f.start();
  assert.equal((await panel.post(f.body(d), 'settings', '')).status, 403);
  assert.equal(d.logins, 0);
  const logged = await panel.post(f.body(d)); assert.equal(logged.status, 200);
  const payload = await logged.json(); assert.equal(payload.authenticated, true); assert.equal(payload.settings.passwordSaved, true);
  assert.equal(d.codec, 1);
  const configText = await readFile(f.configFile, 'utf8'); const stored = JSON.parse(configText);
  assert.ok(!configText.includes(d.config.password));
  assert.equal(await readFile(stored.passwordFile, 'utf8'), d.config.password + '\n');
  assert.equal((await stat(stored.passwordFile)).mode & 0o077, 0);
  assert.equal((await stat(f.configFile)).mode & 0o077, 0);
  const publicData = JSON.stringify([payload, await panel.get('settings.json'), await panel.get('status.json'), await panel.c.tool('linkr_panel').result]);
  const trace = await readFile(f.logFile, 'utf8');
  for (const secret of [d.config.password, hashPassword(d.config.password)]) { assert.ok(!publicData.includes(secret)); assert.ok(!trace.includes(secret)); }
  assert.ok((await panel.c.tool('linkr_computer_use', { action: 'click', coordinate: [10, 10] }).result).isError, 'new device must be captured before agent input');
  assert.equal(d.hidFrames.length, 0);
  assert.ok(!(await panel.c.tool('linkr_computer_use', { action: 'capture' }).result).isError);
});

test('wrong password leaves the previous saved login and live session intact', async t => {
  const f = await fixture(t); const d = await f.device(); const panel = await f.start();
  assert.equal((await panel.post(f.body(d))).status, 200);
  const previous = await readFile(f.configFile, 'utf8'); const revision = (await panel.get('status.json')).revision;
  const failed = await panel.post(f.body(d, 'wrong-password'));
  assert.equal(failed.status, 401);
  assert.ok(!(await failed.text()).includes('wrong-password'));
  assert.equal(await readFile(f.configFile, 'utf8'), previous);
  const status = await panel.get('status.json'); assert.equal(status.revision, revision); assert.equal(status.state.connected, true); assert.equal(d.codec, 1);
});

test('settings persist across server restart, including blank-password updates and encoding controls', async t => {
  const f = await fixture(t); const d = await f.device(); const first = await f.start();
  assert.equal((await first.post(f.body(d))).status, 200); await first.c.close(); assert.equal(d.codec, 0);
  const second = await f.start(); const settings = await second.get('settings.json'); assert.equal(settings.passwordSaved, true); assert.equal(settings.username, d.config.username);
  const changed = await second.post({ ...f.body(d, ''), streamFps: 12, jpegQuality: 8 }); assert.equal(changed.status, 200);
  const parsed = readConfig(f.env); assert.equal(parsed.client.password, d.config.password); assert.equal(parsed.client.fps, 12); assert.equal(parsed.client.jpegQuality, 8); assert.equal(parsed.client.codec, 'mjpeg');
  assert.equal((await readdir(join(f.scratch, 'credentials'))).length, 1, 'superseded managed passwords were not removed');
});

test('changing device requires a fresh password and restores the old mode before connecting', async t => {
  const f = await fixture(t); const a = await f.device(); const b = await f.device({ password: 'another-password', loginDelayMs: 150 }); const panel = await f.start();
  await panel.post(f.body(a));
  assert.equal((await panel.post(f.body(b, ''))).status, 400); assert.equal(b.logins, 0);
  const waiting = panel.c.tool('linkr_computer_use', { action: 'wait', seconds: 20 });
  const change = panel.post(f.body(b));
  for (let i = 0; i < 100 && !(await panel.get('status.json')).configuring; i += 1) await sleep(5);
  const input = await panel.c.tool('linkr_computer_use', { action: 'click', coordinate: [10, 10] }).result;
  assert.ok(input.isError); assert.ok((await waiting.result).isError);
  assert.equal((await change).status, 200); assert.equal(a.codec, 0); assert.equal(b.codec, 1); assert.equal(a.hidFrames.length + b.hidFrames.length, 0);
  assert.ok((await panel.c.tool('linkr_computer_use', { action: 'click', coordinate: [10, 10] }).result).isError);
});

test('Stop interrupts a pending login and cannot be followed by a late automatic connection', async t => {
  const f = await fixture(t); const a = await f.device(); const b = await f.device({ password: 'new-password', loginDelayMs: 1000 }); const panel = await f.start();
  await panel.post(f.body(a)); const previous = await readFile(f.configFile, 'utf8');
  const pending = panel.post(f.body(b));
  for (let i = 0; i < 100 && !(await panel.get('status.json')).configuring; i += 1) await sleep(5);
  const stop = await Promise.race([panel.c.tool('linkr_panel', { action: 'stop' }).result, sleep(700).then(() => { throw new Error('Stop waited for the slow login'); })]);
  assert.ok(!stop.isError); assert.equal((await pending).status, 409);
  await sleep(1100); assert.equal(a.codec, 0); assert.equal(b.codec, 0); assert.equal(b.whepCalls, 0);
  assert.equal(await readFile(f.configFile, 'utf8'), previous);
});

test('logout removes the managed password and prevents automatic reconnect', async t => {
  const f = await fixture(t); const d = await f.device(); const panel = await f.start();
  await panel.post(f.body(d)); const stored = JSON.parse(await readFile(f.configFile, 'utf8'));
  const response = await panel.post({}, 'logout'); assert.equal(response.status, 200);
  assert.equal((await response.json()).settings.passwordSaved, false); assert.equal(d.codec, 0);
  await assert.rejects(readFile(stored.passwordFile), { code: 'ENOENT' });
  assert.ok((await panel.c.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  assert.equal((await panel.get('settings.json')).passwordSaved, false);
});
