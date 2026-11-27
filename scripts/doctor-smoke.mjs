#!/usr/bin/env node
/**
 * Verify scripts/doctor.mjs without touching the real machine or device.
 *
 * Everything (HOME, CODEX_HOME, XDG_CONFIG_HOME, MIMOCODE_CONFIG_DIR,
 * MINIMAX_DATA_DIR, config project) lives in a throwaway directory, and the
 * device checks are skipped, so doctor runs exactly as a user would run it but
 * against a clean, empty profile.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeDevice } from '../dsh-linkr/test/fake-device.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs');
const SETUP = join(ROOT, 'scripts', 'setup.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'harness-linkr-doctor-'));
const home = join(scratch, 'home');
const project = join(scratch, 'project');
const stateDir = join(scratch, 'state');
const env = {
  HOME: home,
  CODEX_HOME: join(scratch, 'codex'),
  XDG_CONFIG_HOME: join(scratch, 'xdg'),
  MIMOCODE_CONFIG_DIR: join(scratch, 'mimo'),
  MINIMAX_DATA_DIR: join(scratch, 'minimax'),
  LINKR_STATE_DIR: stateDir,
  LINKR_USERNAME: 'tester',
};
for (const dir of [home, project, stateDir, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.MIMOCODE_CONFIG_DIR, env.MINIMAX_DATA_DIR]) {
  mkdirSync(dir, { recursive: true });
}

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

function runDoctor(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOCTOR, ...args], {
      cwd: options.cwd ?? project,
      env: { ...process.env, ...env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

function entryOf(report, name) {
  return report.report.find((entry) => entry.name === name);
}

async function main() {
  const missing = new Set();
  for (const [name, cli] of Object.entries({ codex: 'codex', opencode: 'opencode', mimocode: 'mimo' })) {
    if (spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', cli]).status !== 0) missing.add(name);
  }

  await check('empty profile: warn for unconfigured clients and skip missing clients', async () => {
    const result = await runDoctor(['--no-device', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const parsed = parseJson(result);
    assert.equal(parsed.ok, true);
    for (const name of ['codex', 'opencode', 'mimocode', 'minimaxcode']) {
      const entry = entryOf(parsed, name);
      assert.ok(entry, `no ${name} entry`);
      const expected = missing.has(name) ? 'SKIP' : 'WARN';
      assert.equal(entry.level, expected, `${name}: ${entry.detail}`);
      if (expected === 'WARN') assert.ok(entry.fix, `${name} warning carries no fix`);
    }
    assert.equal(entryOf(parsed, 'restore journal').level, 'PASS');
  });

  await check('configured profile: distinguish installed clients from config files alone', async () => {
    const password = join(scratch, 'device-password');
    writeFileSync(password, 'smoke-password\n', { mode: 0o600 });
    const setup = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        SETUP,
        '--harness', 'all',
        '--username', 'tester',
        '--password-file', password,
        '--project', project,
      ], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
      child.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(setup.code, 0, setup.stderr);

    const result = await runDoctor(['--no-device', '--json'], { env: { LINKR_PASSWORD_FILE: password } });
    assert.equal(result.code, 0, result.stderr);
    const parsed = parseJson(result);
    for (const name of ['codex', 'opencode', 'mimocode', 'minimaxcode']) {
      const entry = entryOf(parsed, name);
      if (missing.has(name) && name !== 'codex') {
        assert.equal(entry?.level, 'WARN', `${name}: expected a config-only warning`);
        assert.match(entry.detail, /not on PATH/i);
      } else {
        const expected = missing.has(name) ? 'SKIP' : 'PASS';
        assert.equal(entry?.level, expected, `${name}: ${entry?.detail}`);
      }
    }
    assert.equal(entryOf(parsed, 'device password file').level, 'PASS');
  });

  await check('OpenCode is optional with and without a project config', async () => {
    const cwd = mkdtempSync(join(scratch, 'opencode-project-'));
    const bin = mkdtempSync(join(scratch, 'bin-'));
    const options = { cwd, env: { PATH: bin } };
    async function expectOpenCode(level) {
      const result = await runDoctor(['--no-device', '--json'], options);
      assert.equal(result.code, 0, result.stderr);
      const entry = entryOf(parseJson(result), 'opencode');
      assert.equal(entry?.level, level, entry?.detail);
    }

    await expectOpenCode('SKIP');
    const config = join(cwd, 'opencode.json');
    writeFileSync(config, JSON.stringify({ mcp: { servers: { linkr: { type: 'local' } } } }));
    await expectOpenCode('WARN');
    // doctor only asks the installed OpenCode binary for its version.
    writeFileSync(join(bin, 'opencode'), '#!/bin/sh\n[ "$1" = --version ] && echo 2.2.7\n', { mode: 0o755 });
    await expectOpenCode('PASS');
    rmSync(config);
    await expectOpenCode('WARN');
  });

  await check('a stale restore journal is reported with its fix', async () => {
    writeFileSync(
      join(stateDir, 'mcp-session.json'),
      JSON.stringify({ pid: 999999, origin: 'http://127.0.0.1:1', baselineMode: 0, mode: 2, at: Date.now() }),
    );
    const result = await runDoctor(['--no-device', '--json']);
    assert.equal(result.code, 0, result.stderr);
    const entry = entryOf(parseJson(result), 'restore journal');
    assert.equal(entry.level, 'WARN');
    assert.match(entry.fix, /--restore-mode/);
  });

  await check('permissions on the password file are checked', async () => {
    const password = join(scratch, 'device-password');
    chmodSync(password, 0o644);
    const result = await runDoctor(['--no-device', '--json'], { env: { LINKR_PASSWORD_FILE: password } });
    const entry = entryOf(parseJson(result), 'device password file');
    assert.equal(entry.level, 'WARN');
    assert.match(entry.fix, /chmod 600/);
  });

  await check('--fix tightens the password file and heals a stale journal', async () => {
    const password = join(scratch, 'device-password');
    chmodSync(password, 0o644);
    writeFileSync(join(stateDir, 'username'), 'tester\n', { mode: 0o600 });

    // A device whose mode is stranded, and a journal whose owner is gone.
    const fake = createFakeDevice({ username: 'tester', password: 'smoke-password', initialCodec: 0, frameIntervalMs: 40 });
    const origin = await fake.listen();
    fake.setCodec(1);
    writeFileSync(
      join(stateDir, 'mcp-session.json'),
      JSON.stringify({ pid: 999999, origin, baselineMode: 0, mode: 1, at: Date.now() }),
    );
    try {
      const result = await runDoctor(['--fix', '--json'], { env: { LINKR_BASE_URL: origin, LINKR_USERNAME: 'tester', LINKR_PASSWORD_FILE: password } });
      assert.equal(result.code, 0, result.stderr);
      const parsed = parseJson(result);

      const perms = entryOf(parsed, 'device password file');
      assert.equal(perms.level, 'PASS', `password file: ${JSON.stringify(perms)}`);
      assert.match(perms.detail, /fixed mode/);
      assert.equal(statSync(password).mode & 0o077, 0);

      const journal = entryOf(parsed, 'restore journal');
      assert.equal(journal.level, 'PASS', `journal: ${JSON.stringify(journal)}`);
      assert.match(journal.detail, /healed/);
      assert.equal(fake.codec, 0, 'device mode was not restored');
    } finally {
      await fake.close();
    }
  });

  await check('--no-device --fix refuses to guess about a stale journal', async () => {
    writeFileSync(
      join(stateDir, 'mcp-session.json'),
      JSON.stringify({ pid: 999998, origin: 'http://127.0.0.1:1', baselineMode: 0, mode: 1, at: Date.now() }),
    );
    const result = await runDoctor(['--no-device', '--fix', '--json']);
    const entry = entryOf(parseJson(result), 'restore journal');
    assert.equal(entry.level, 'WARN');
    assert.match(entry.detail, /could not heal/);
    assert.ok(readFileSync(join(stateDir, 'mcp-session.json')), 'journal should be left for a later run');
  });

  rmSync(scratch, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  rmSync(scratch, { recursive: true, force: true });
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
