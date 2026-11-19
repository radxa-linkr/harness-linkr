import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startMcp } from './rpc-client.mjs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFakeDevice } from '../../dsh-linkr/test/fake-device.mjs';
import { LinkrClient } from '../../dsh-linkr/lib/index.js';
import { createLinkrTools } from '../tools.js';
import { createPanelBridge } from '../panel.js';

const server = fileURLToPath(new URL('../index.js', import.meta.url));
async function until(fn) {
  const deadline = Date.now() + 6000;
  while (!fn()) { assert.ok(Date.now() < deadline, 'condition timed out'); await sleep(10); }
}
async function fixture(t, extraEnv = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'linkr-safety-'));
  const fake = createFakeDevice({ initialCodec: 0 });
  const origin = await fake.listen();
  const env = { LINKR_BASE_URL: origin, LINKR_USERNAME: 'tester', LINKR_PASSWORD: 's3cret', LINKR_CODEC: 'mjpeg', LINKR_STATE_DIR: join(scratch, 'state'), LINKR_SAVE_DIR: join(scratch, 'captures'), LINKR_IDLE_STOP_MS: '60000', ...extraEnv };
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await fake.close(); await rm(scratch, { recursive: true, force: true }); });
  async function start() {
    const client = startMcp(env); clients.push(client);
    await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-safety', version: '1' } }).result;
    client.notify('notifications/initialized'); return client;
  }
  return { fake, env, scratch, start };
}

test('SIGKILL after mode write but before first frame is recoverable', async t => {
  const { fake, env, scratch, start } = await fixture(t);
  const client = await start();
  const capture = client.tool('linkr_computer_use', { action: 'capture' });
  await until(() => fake.codec === 1);
  const files = await readdir(join(scratch, 'state'));
  const journal = JSON.parse(await readFile(join(scratch, 'state', files.find(name => name.endsWith('.json'))), 'utf8'));
  assert.equal(journal.baselineMode, 0);
  await client.close('SIGKILL'); await capture.result;
  const restore = spawn(process.execPath, [server, '--restore-mode'], { env: { ...process.env, ...env }, stdio: 'ignore' });
  const [code] = await once(restore, 'exit');
  assert.equal(code, 0); assert.equal(fake.codec, 0);
});

test('an idle-stopped session releases the device lease for another app', async t => {
  const { fake, start } = await fixture(t, { LINKR_IDLE_STOP_MS: '300' });
  const first = await start();
  assert.ok(!(await first.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  await until(() => fake.codec === 1);
  // No viewer, no input: the transport idles the session out and restores the mode.
  await until(() => fake.codec === 0);
  await sleep(200);
  const second = await start();
  const capture = await second.tool('linkr_computer_use', { action: 'capture' }).result;
  assert.ok(!capture.isError, `another app could not connect after the idle stop: ${JSON.stringify(capture).slice(0, 200)}`);
  assert.equal(fake.codec, 1);
});

test('cancelled queued click never reaches HID, and a running wait is interruptible', async t => {
  const { fake, start } = await fixture(t); const client = await start();
  assert.ok(!(await client.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  const before = fake.hidFrames.length;
  const wait = client.tool('linkr_computer_use', { action: 'wait', seconds: 20 });
  await sleep(50);
  const click = client.tool('linkr_computer_use', { action: 'click', coordinate: [10, 10] });
  client.notify('notifications/cancelled', { requestId: click.id });
  client.notify('notifications/cancelled', { requestId: wait.id });
  assert.ok((await click.result).isError); assert.ok((await wait.result).isError);
  await sleep(100); assert.equal(fake.hidFrames.length, before);
});

test('second process cannot disturb an existing session; it can connect after release', async t => {
  const { fake, start } = await fixture(t); const first = await start();
  assert.ok(!(await first.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  const second = await start();
  assert.ok((await second.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  assert.equal(fake.whepCalls, 1); assert.equal(fake.codec, 1);
  await first.close(); assert.equal(fake.codec, 0);
  assert.ok(!(await second.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  assert.equal(fake.codec, 1);
});

test('human takeover pauses agent input and expires by explicit release; Stop stays stopped', async t => {
  const { fake, start } = await fixture(t); const client = await start(); const viewId = 'test-panel';
  await client.tool('linkr_panel', { action: 'start' }).result;
  await client.tool('linkr_panel', { action: 'take_control', viewId }).result;
  const before = fake.hidFrames.length;
  assert.ok((await client.tool('linkr_computer_use', { action: 'click', coordinate: [10, 10] }).result).isError);
  assert.ok((await client.tool('linkr_panel_input', { action: 'click', viewId: 'wrong-panel', coordinate: [10, 10] }).result).isError);
  assert.equal(fake.hidFrames.length, before);
  assert.ok(!(await client.tool('linkr_panel_input', { action: 'click', viewId, coordinate: [10, 10] }).result).isError);
  await fake.waitForHid(before + 3);
  await client.tool('linkr_panel', { action: 'release_control', viewId }).result;
  assert.ok(!(await client.tool('linkr_computer_use', { action: 'key', keys: 'return' }).result).isError);
  const waiting = client.tool('linkr_computer_use', { action: 'wait', seconds: 20 });
  const queued = client.tool('linkr_computer_use', { action: 'click', coordinate: [20, 20] });
  const stop = client.tool('linkr_panel', { action: 'stop' });
  await stop.result; await waiting.result; assert.ok((await queued.result).isError);
  assert.equal(fake.codec, 0);
  const calls = fake.whepCalls;
  assert.ok((await client.tool('linkr_computer_use', { action: 'capture' }).result).isError);
  await client.tool('linkr_panel_frame').result;
  assert.equal(fake.whepCalls, calls); assert.equal(fake.codec, 0);
  assert.ok(!(await client.tool('linkr_panel', { action: 'start' }).result).isError);
});

test('panel opens passively, exposes only authenticated reads, and shares one media session', async t => {
  const { fake, start } = await fixture(t); const client = await start();
  const list = await client.request('tools/list').result;
  const panel = list.tools.find(tool => tool.name === 'linkr_panel');
  assert.deepEqual(panel._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  const open = await client.tool('linkr_panel').result;
  const url = open._meta.linkr.previewUrl;
  const resource = await client.request('resources/read', { uri: panel._meta.ui.resourceUri }).result;
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.contents[0].text.includes('人工接管'));
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, [new URL(url).origin]);
  assert.equal((await fetch(new URL('/invalid/status.json', url))).status, 403);
  assert.equal((await fetch(url + 'status.json', { method: 'POST' })).status, 405);
  assert.equal(fake.whepCalls, 0); assert.equal(fake.codecWrites.length, 0);
  await client.tool('linkr_panel', { action: 'start' }).result;
  const response = await fetch(url + 'live.mjpeg');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
  const reader = response.body.getReader(); const frame = await reader.read();
  assert.ok(Buffer.from(frame.value).includes(Buffer.from([0xff, 0xd8])));
  await reader.cancel();
  const snapshot = await client.tool('linkr_panel_frame').result;
  assert.equal(snapshot.content[0].type, 'image');
  await client.tool('linkr_computer_use', { action: 'capture' }).result;
  assert.equal(fake.whepCalls, 1);
});

test('a long agent wait cannot block panel preview, takeover heartbeat, or release', async t => {
  const { start } = await fixture(t); const client = await start(); const viewId = 'responsive-panel';
  await client.tool('linkr_panel', { action: 'start' }).result;
  await client.tool('linkr_panel', { action: 'take_control', viewId }).result;
  const wait = client.tool('linkr_computer_use', { action: 'wait', seconds: 20 });
  await sleep(50);
  const heartbeat = client.tool('linkr_panel', { action: 'heartbeat', viewId });
  const preview = client.tool('linkr_panel_frame');
  const open = client.tool('linkr_panel');
  const results = await Promise.race([
    Promise.all([heartbeat.result, preview.result, open.result]),
    sleep(1000).then(() => { throw new Error('read-only panel requests were blocked behind the agent wait'); }),
  ]);
  assert.equal(results[0].structuredContent.controlViewId, viewId);
  assert.equal(results[1].content[0].type, 'image');
  const released = await client.tool('linkr_panel', { action: 'release_control', viewId }).result;
  assert.equal(released.structuredContent.controlViewId, '');
  assert.ok((await wait.result).isError);
});

test('clipboard capability is cached, excludes copied text, and cannot revive a stopped session', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'linkr-capability-'));
  const fake = createFakeDevice({ initialCodec: 0 });
  const origin = await fake.listen();
  const previousStateDir = process.env.LINKR_STATE_DIR;
  process.env.LINKR_STATE_DIR = join(scratch, 'state');
  const original = LinkrClient.prototype.clipboardStatus;
  let probes = 0, release;
  LinkrClient.prototype.clipboardStatus = async () => {
    probes += 1;
    await new Promise(resolve => { release = resolve; });
    return { available: true, reason: '', text: 'private clipboard fixture', token: 'private token fixture' };
  };
  const tools = createLinkrTools({ client: { baseUrl: origin, username: 'tester', password: 's3cret', codec: 'mjpeg', manageVideoMode: true } });
  const panel = createPanelBridge(tools);
  t.after(async () => {
    release?.();
    await panel.close(); await tools.dispose(); await fake.close();
    LinkrClient.prototype.clipboardStatus = original;
    if (previousStateDir === undefined) delete process.env.LINKR_STATE_DIR; else process.env.LINKR_STATE_DIR = previousStateDir;
    await rm(scratch, { recursive: true, force: true });
  });
  const url = (await panel.metadata()).linkr.previewUrl + 'clipboard.json';
  assert.equal((await (await fetch(url)).json()).clipboard, null);
  assert.equal(fake.whepCalls, 0); assert.equal(probes, 0);
  await tools.callTool('linkr_panel', { action: 'start' });
  const first = fetch(url).then(response => response.json());
  await until(() => probes === 1);
  const second = fetch(url).then(response => response.json());
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.clipboard, { available: true, reason: '' });
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('private'));
  await fetch(url); assert.equal(probes, 1);
  await tools.callTool('linkr_panel', { action: 'stop' });
  assert.equal((await (await fetch(url)).json()).clipboard, null);
  assert.equal(fake.codec, 0); assert.equal(fake.whepCalls, 1);
  await tools.callTool('linkr_panel', { action: 'start' });
  const stale = fetch(url).then(response => response.json());
  await until(() => probes === 2);
  await tools.callTool('linkr_panel', { action: 'stop' });
  release();
  assert.deepEqual(await stale, { revision: tools.panelState().revision, clipboard: null });
  assert.equal(fake.codec, 0); assert.equal(fake.whepCalls, 2);
});
