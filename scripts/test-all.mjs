#!/usr/bin/env node
/**
 * Run every suite in the repository and summarise.
 *
 *   node scripts/test-all.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { name: 'dsh-linkr unit tests', cwd: join(ROOT, 'dsh-linkr'), command: process.execPath, args: ['--test', 'test/client.test.mjs', 'test/control.test.mjs', 'test/ffmpeg.test.mjs', 'test/h264.test.mjs', 'test/hid.test.mjs', 'test/linkr.test.mjs', 'test/locale.test.mjs', 'test/wsmedia.test.mjs'] },
  { name: 'dsh-linkr host smoke', cwd: join(ROOT, 'dsh-linkr'), command: process.execPath, args: ['test/host-smoke.mjs'] },
  { name: 'mcp-linkr journal unit', cwd: join(ROOT, 'mcp-linkr'), command: process.execPath, args: ['test/device-mode.test.mjs'] },
  { name: 'mcp-linkr stdio smoke', cwd: join(ROOT, 'mcp-linkr'), command: process.execPath, args: ['test/mcp-smoke.mjs'] },
  { name: 'MCP session safety and live panel', cwd: ROOT, command: process.execPath, args: ['--test', 'mcp-linkr/test/session-safety.test.mjs'] },
  { name: 'Private plugin login and device switching', cwd: ROOT, command: process.execPath, args: ['--test', 'mcp-linkr/test/settings.test.mjs'] },
  { name: 'Codex policy preservation', cwd: ROOT, command: process.execPath, args: ['--test', 'scripts/codex-config.test.mjs'] },
  { name: 'setup script smoke', cwd: ROOT, command: process.execPath, args: ['scripts/setup-smoke.mjs'] },
  { name: 'dsh/mcp parity guard', cwd: ROOT, command: process.execPath, args: ['scripts/parity-check.mjs'] },
  { name: 'doctor smoke', cwd: ROOT, command: process.execPath, args: ['scripts/doctor-smoke.mjs'] },
  { name: 'docs/adapters consistency', cwd: ROOT, command: process.execPath, args: ['scripts/docs-check.mjs'] },
  { name: 'packaging smoke', cwd: ROOT, command: process.execPath, args: ['scripts/pack-smoke.mjs'] },
  // Skips (exit 0) when @modelcontextprotocol/sdk is not installed; see docs/MCP-COMPLIANCE.md.
  { name: 'official MCP SDK compliance', cwd: ROOT, command: process.execPath, args: ['scripts/mcp-compliance.mjs'] },
];

function runSuite(suite) {
  return new Promise((resolveSuite) => {
    const child = spawn(suite.command, suite.args, { cwd: suite.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.on('error', (error) => resolveSuite({ ok: false, out: `${out}${error.message}` }));
    child.on('exit', (code) => resolveSuite({ ok: code === 0, code, out }));
  });
}

async function main() {
  const failures = [];
  process.stdout.write('\n=== materialize core/ into dsh-linkr/lib\n');
  const sync = await new Promise((resolveSync) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'sync-core.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (out += chunk.toString('utf8')));
    child.on('exit', (code) => resolveSync({ ok: code === 0, out }));
  });
  process.stdout.write(`${sync.out.trim()}\n`);
  if (!sync.ok) failures.push('sync-core');
  for (const suite of SUITES) {
    process.stdout.write(`\n=== ${suite.name}\n`);
    const result = await runSuite(suite);
    const lines = result.out.trim().split('\n');
    process.stdout.write(`${lines.slice(-6).join('\n')}\n`);
    if (!result.ok) failures.push(suite.name);
  }
  process.stdout.write(failures.length === 0 ? '\nALL SUITES PASSED\n' : `\nFAILED: ${failures.join(', ')}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
