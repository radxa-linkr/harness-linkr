#!/usr/bin/env node
/**
 * End-to-end test of the Linkr MCP server over a real stdio pipe.
 *
 * Spawns `index.js` exactly the way a harness does, speaks MCP JSON-RPC to it,
 * and drives a fake Linkr device (the same fake the DSH plugin uses):
 *  - initialize / notifications/initialized handshake
 *  - tools/list exposes linkr_status and linkr_computer_use
 *  - linkr_status reports the fake device
 *  - capture returns an inline image block and writes the file
 *  - click reaches the device as HID frames
 *  - capture_after returns a second image in the same call
 *  - an unknown tool answers isError instead of killing the process
 *  - --status one-shot mode works
 *  - closing stdin disposes the client and restores the device video mode
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeDevice } from '../../dsh-linkr/test/fake-device.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'index.js');
const SAVE_DIR = mkdtempSync(join(tmpdir(), 'linkr-mcp-smoke-'));
const STATE_DIR = join(SAVE_DIR, 'state');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** Minimal MCP client over a child process's stdio. */
function startClient(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  const buffer = { partial: '' };

  child.stdout.on('data', (chunk) => {
    buffer.partial += chunk.toString('utf8');
    let index;
    while ((index = buffer.partial.indexOf('\n')) >= 0) {
      const line = buffer.partial.slice(0, index).trim();
      buffer.partial = buffer.partial.slice(index + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stderr += `[non-JSON stdout] ${line}\n`;
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  function request(method, params) {
    const id = nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.slice(-400)}`));
      }, 30000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  async function close() {
    child.stdin.end();
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
    const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
    if (code === 'timeout') child.kill('SIGKILL');
    return { code, stderr };
  }

  return { request, notify, close, child, get stderr() { return stderr; } };
}

function imageBlocks(result) {
  return (result?.content ?? []).filter((block) => block.type === 'image');
}

function textOf(result) {
  return (result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => (err += chunk.toString('utf8')));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  return { code, out, err };
}

async function main() {
  const fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 0, frameIntervalMs: 40 });
  const origin = await fake.listen();
  const env = {
    LINKR_BASE_URL: origin,
    LINKR_USERNAME: 'tester',
    LINKR_PASSWORD: 's3cret',
    LINKR_CODEC: 'mjpeg',
    LINKR_STREAM_FPS: 10,
    LINKR_SAVE_DIR: SAVE_DIR,
    LINKR_STATE_DIR: STATE_DIR,
    LINKR_INLINE_IMAGES: '1',
    LINKR_IDLE_STOP_MS: '60000',
  };

  const client = startClient(env);
  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke', version: '0.0.0' },
    });
    check('initialize: server info and tool capability', () => {
      assert.equal(init.serverInfo.name, 'linkr');
      assert.ok(init.capabilities.tools);
      assert.ok(['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.protocolVersion));
      assert.match(init.instructions ?? '', /untrusted data/);
    });
    client.notify('notifications/initialized');

    const list = await client.request('tools/list');
    check('tools/list: status + computer use with the full action enum', () => {
      const names = list.tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, ['linkr_computer_use', 'linkr_panel', 'linkr_panel_frame', 'linkr_panel_input', 'linkr_status']);
      const computer = list.tools.find((tool) => tool.name === 'linkr_computer_use');
      const actions = computer.inputSchema.properties.action.enum;
      for (const action of ['capture', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait', 'paste', 'clipboard']) {
        assert.ok(actions.includes(action), `missing action ${action}`);
      }
      assert.deepEqual(computer.inputSchema.required, ['action']);
    });

    const status = await client.request('tools/call', { name: 'linkr_status', arguments: {} });
    check('linkr_status: reports the fake device', () => {
      const text = textOf(status);
      assert.match(text, /Fake Linkr/);
      assert.match(text, /linkr_computer_use/);
      assert.ok(!status.isError);
    });

    const capture = await client.request('tools/call', { name: 'linkr_computer_use', arguments: { action: 'capture' } });
    check('capture: inline image block + JPEG on disk', () => {
      const images = imageBlocks(capture);
      assert.equal(images.length, 1, 'expected one image block');
      const bytes = Buffer.from(images[0].data, 'base64');
      assert.ok(bytes.subarray(0, 2).equals(JPEG_MAGIC), 'inline image is not a JPEG');
      assert.equal(images[0].mimeType, 'image/jpeg');
      const path = /at (\/[^\s]+?\.jpg)/.exec(textOf(capture))?.[1];
      assert.ok(path, 'capture text does not name the file');
      const saved = readFileSync(path);
      assert.ok(saved.subarray(0, 2).equals(JPEG_MAGIC), 'saved file is not a JPEG');
      assert.equal(saved.length, bytes.length);
    });

    const before = fake.hidFrames.length;
    await sleep(300);
    const click = await client.request('tools/call', {
      name: 'linkr_computer_use',
      arguments: { action: 'click', coordinate: [320, 180] },
    });
    await sleep(400);
    check('click: accepted, HID frames reached the device', () => {
      assert.ok(!click.isError, textOf(click));
      assert.match(textOf(click), /clicked at \(320, 180\)/);
      assert.ok(fake.hidFrames.length > before, 'no HID frame arrived on the fake device');
    });

    const after = await client.request('tools/call', {
      name: 'linkr_computer_use',
      arguments: { action: 'wait', seconds: 0.2, capture_after: true },
    });
    check('capture_after: a second capture in the same call', () => {
      assert.equal(imageBlocks(after).length, 1);
      assert.match(textOf(after), /Follow-up capture/);
      assert.match(textOf(after), /Waited 0\.2 s/);
    });

    const outOfFrame = await client.request('tools/call', {
      name: 'linkr_computer_use',
      arguments: { action: 'click', coordinate: [5000, 10] },
    });
    check('out-of-frame coordinate is refused with the frame size', () => {
      assert.equal(outOfFrame.isError, true);
      assert.match(textOf(outOfFrame), /outside the captured frame/);
      assert.match(textOf(outOfFrame), /0\.\.640, 0\.\.360/);
    });

    const unknown = await client.request('tools/call', { name: 'nope', arguments: {} });
    check('unknown tool: isError, process stays alive', () => {
      assert.equal(unknown.isError, true);
      assert.match(textOf(unknown), /unknown tool/);
    });

    // A second status call proves the process did not die after the error.
    const alive = await client.request('tools/call', { name: 'linkr_status', arguments: {} });
    check('server survives an error and still answers', () => assert.ok(!alive.isError));

    const checkConfig = await runCli(['--check-config'], env);
    check('--check-config reports the resolved configuration with the password masked', () => {
      assert.equal(checkConfig.code, 0, checkConfig.err);
      const report = JSON.parse(checkConfig.out);
      assert.equal(report.device.baseUrl, env.LINKR_BASE_URL);
      assert.equal(report.credentials.password, '(set)');
      assert.equal(report.credentials.source, 'LINKR_PASSWORD');
      assert.equal(report.stream.codec, 'mjpeg');
      assert.ok(!checkConfig.out.includes(env.LINKR_PASSWORD), 'the password leaked into --check-config output');
    });
    const missingConfig = await runCli(['--check-config'], {
      ...env,
      LINKR_BASE_URL: '',
      LINKR_USERNAME: '',
      LINKR_PASSWORD: '',
      LINKR_PASSWORD_FILE: '',
    });
    check('--check-config exits 2 and names the missing settings', () => {
      assert.equal(missingConfig.code, 2, missingConfig.err);
      assert.match(missingConfig.err, /LINKR_BASE_URL/);
      assert.match(missingConfig.err, /LINKR_USERNAME/);
      assert.match(missingConfig.err, /LINKR_PASSWORD/);
    });

    const statusRun = await runCli(['--status'], env);
    check('--status: one-shot report exits 0', () => {
      assert.equal(statusRun.code, 0, statusRun.err);
      assert.match(statusRun.out, /Fake Linkr/);
    });

  } finally {
    const closed = await client.close();
    check('shutdown: stdin close disposes the session', () => {
      assert.equal(closed.code, 0, `exit code ${closed.code}; stderr=${closed.stderr.slice(-400)}`);
    });
    const deadline = Date.now() + 3000;
    while (fake.codec !== 0 && Date.now() < deadline) await sleep(50);
    check('shutdown: device video mode restored', () => assert.equal(fake.codec, 0));

    // A harness may SIGKILL the server instead of closing stdin (Codex does).
    // The device must not be left in the mode the killed server switched it to.
    const rude = startClient(env);
    await rude.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mcp-smoke-rude', version: '0.0.0' },
    });
    rude.notify('notifications/initialized');
    const rudeCapture = await rude.request('tools/call', { name: 'linkr_computer_use', arguments: { action: 'capture' } });
    check('capture before SIGKILL leaves the device switched', () => {
      assert.ok(!rudeCapture.isError, textOf(rudeCapture));
      assert.equal(fake.codec, 1, 'expected the session to hold MJPEG mode');
    });
    const exited = new Promise((resolve) => rude.child.on('exit', () => resolve(true)));
    rude.child.kill('SIGKILL');
    await exited;
    await sleep(300);
    check('SIGKILL strands the device mode (the situation recovery must fix)', () => {
      assert.equal(fake.codec, 1, 'the kill unexpectedly restored the mode already');
    });
    const healed = await runCli(['--restore-mode'], env);
    check('--restore-mode heals the mode left by the killed server', () => {
      assert.equal(healed.code, 0, healed.err);
      const report = JSON.parse(healed.out.trim().split('\n').pop());
      assert.equal(report.recovered, true);
      assert.equal(fake.codec, 0);
    });
    await fake.close();
    rmSync(SAVE_DIR, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
