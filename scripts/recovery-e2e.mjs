#!/usr/bin/env node
/**
 * Kill the MCP server mid-session and prove the device mode is healed.
 *
 * The fake device is local, so this needs no hardware and no device lease from
 * other apps: capture switches the codec 0 -> 1 and writes the journal, SIGKILL
 * leaves both behind, and `--restore-mode` restores 0 and removes the journal.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeDevice } from '../dsh-linkr/test/fake-device.mjs';
import { startMcp } from '../mcp-linkr/test/rpc-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp-linkr', 'index.js');
const scratch = mkdtempSync(join(tmpdir(), 'linkr-recovery-e2e-'));
const fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 0 });

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

try {
  await fake.listen();
  const base = fake.origin;
  const stateDir = join(scratch, 'state');
  const env = {
    LINKR_BASE_URL: base,
    LINKR_USERNAME: 'tester',
    LINKR_PASSWORD: 's3cret',
    LINKR_STATE_DIR: stateDir,
    LINKR_SAVE_DIR: join(scratch, 'captures'),
    LINKR_CODEC: 'mjpeg',
    LINKR_FFMPEG_PATH: '/nonexistent-ffmpeg',
  };
  const journal = join(stateDir, `mcp-session-${createHash('sha256').update(base).digest('hex').slice(0, 24)}.json`);

  if (fake.codec !== 0) fail(`the fake device did not start at codec 0 (${fake.codec})`);
  const first = startMcp(env);
  try {
    await first.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'recovery-e2e', version: '1' },
    }).result;
    const capture = await first.tool('linkr_computer_use', { action: 'capture' }).result;
    if (capture.isError) fail(`capture failed: ${JSON.stringify(capture).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 500));
    if (fake.codec !== 1) fail(`capture did not switch the device to MJPEG (codec ${fake.codec})`);
    if (!existsSync(journal)) fail('capture did not write the journal');
    const entry = JSON.parse(readFileSync(journal, 'utf8'));
    if (entry.baselineMode !== 0) fail(`journal baseline is ${entry.baselineMode}, expected 0`);
  } finally {
    await first.close('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
  }
  if (fake.codec !== 1) fail(`SIGKILL unexpectedly restored the mode (codec ${fake.codec})`);
  if (!existsSync(journal)) fail('SIGKILL unexpectedly removed the journal');

  const restore = spawn(process.execPath, [SERVER, '--restore-mode'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  restore.stdout.on('data', (chunk) => (out += chunk));
  restore.stderr.on('data', (chunk) => (err += chunk));
  const code = await new Promise((r) => restore.on('exit', r));
  if (code !== 0) fail(`--restore-mode exited ${code}: ${err.trim()}`);
  const result = JSON.parse(out.trim());
  if (result.recovered !== true || result.mode !== 0) fail(`unexpected restore result: ${out.trim()}`);
  if (fake.codec !== 0) fail(`the device was not restored (codec ${fake.codec})`);
  if (existsSync(journal)) fail('the journal survived a successful restore');
  console.log('PASS  a killed session is journalled, and --restore-mode heals the device');
  console.log('\nALL PASS');
} finally {
  await fake.close().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
}
