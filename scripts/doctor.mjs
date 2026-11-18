#!/usr/bin/env node
/**
 * Doctor: one read-only command that says why Linkr is not working.
 *
 *   node scripts/doctor.mjs            checks this machine and the device
 *   node scripts/doctor.mjs --no-device  skip the network/device checks
 *   node scripts/doctor.mjs --json       machine-readable report
 *   node scripts/doctor.mjs --fix        apply the safe fixes (chmod the password
 *                                        file, heal a stale restore journal)
 *
 * Read-only by default: no config writes, no session, no device setting. The
 * only things --fix changes are the two above; everything else is still printed
 * as the command a person should run.
 */

import { spawn } from 'node:child_process';
import { access, chmod, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJournals, recoverStaleSession } from '../mcp-linkr/device-mode.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp-linkr', 'index.js');
const ARGS = process.argv.slice(2);
const JSON_OUT = ARGS.includes('--json');
const NO_DEVICE = ARGS.includes('--no-device');
const FIX = ARGS.includes('--fix');

const stateDir = process.env.LINKR_STATE_DIR || join(homedir(), '.linkr');
const passwordFile = process.env.LINKR_PASSWORD_FILE || join(stateDir, 'password');
const usernameFile = join(stateDir, 'username');
const baseUrl = process.env.LINKR_BASE_URL || 'http://linkr.local';

const report = [];

function add(level, name, detail = '', fix = '') {
  report.push({ level, name, detail, fix });
  if (!JSON_OUT) {
    const tail = [detail, fix ? `fix: ${fix}` : ''].filter(Boolean).join('  ');
    console.log(`${level.toUpperCase().padEnd(4)}  ${name}${tail ? `  ${tail}` : ''}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', () => resolveRun({ ok: false, stdout, stderr: `${stderr}${command} not found` }));
    child.on('exit', (code) => resolveRun({ ok: code === 0, code: code ?? 0, stdout, stderr }));
  });
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasCommand(name) {
  const result = await run('/bin/sh', ['-c', `command -v ${name} >/dev/null 2>&1`]);
  return result.ok;
}

function clean(text) {
  return String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
}

/* ---------------- checks ---------------- */

async function checkRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) add('PASS', 'node', `v${process.versions.node}`);
  else add('FAIL', 'node', `v${process.versions.node} is too old; the MCP server needs >=22`, 'install Node 22+');

  const ffmpeg = await run('ffmpeg', ['-version']);
  if (ffmpeg.ok) {
    const first = clean(ffmpeg.stdout).split('\n')[0];
    add('PASS', 'ffmpeg', first.slice(0, 60));
  } else {
    add('WARN', 'ffmpeg', 'not found - H.264 decoding needs it; MJPEG still works', 'brew install ffmpeg, or set LINKR_FFMPEG_PATH');
  }

  const serverPresent = await exists(SERVER);
  if (serverPresent) add('PASS', 'mcp-linkr server', SERVER);
  else add('FAIL', 'mcp-linkr server', 'missing', 'run from the harness-linkr repository');
}

async function checkCredentials() {
  if (await exists(passwordFile)) {
    const info = await stat(passwordFile);
    const mode = info.mode & 0o777;
    if ((mode & 0o077) === 0) {
      add('PASS', 'device password file', `${passwordFile} (mode ${mode.toString(8)})`);
    } else if (FIX) {
      try {
        await chmod(passwordFile, 0o600);
        add('PASS', 'device password file', `${passwordFile} (fixed mode ${mode.toString(8)} -> 600)`);
      } catch (error) {
        add('WARN', 'device password file', `${passwordFile} is readable by others and could not be fixed: ${error.message}`, `chmod 600 ${passwordFile}`);
      }
    } else {
      add('WARN', 'device password file', `${passwordFile} is readable by others (mode ${mode.toString(8)})`, `chmod 600 ${passwordFile} (or rerun with --fix)`);
    }
  } else {
    add('WARN', 'device password file', `${passwordFile} is missing`, 'node scripts/setup.mjs --harness codex --username <account> --password-file <file> (or export LINKR_PASSWORD once)');
  }

  if (await exists(usernameFile)) {
    const username = (await readFile(usernameFile, 'utf8')).trim();
    add('PASS', 'device account', username);
  } else {
    add('WARN', 'device account', 'no saved account name', 'the setup script saves it, or pass --username');
  }
}

async function checkJournal() {
  const journals = await readJournals();
  if (journals.length === 0) {
    add('PASS', 'restore journal', 'clean');
    return;
  }
  for (const journal of journals) await checkJournalEntry(journal);
}

async function checkJournalEntry(journal) {
  const alive = Number.isInteger(journal.pid) ? isAlive(journal.pid) : false;
  if (alive) {
    add('WARN', 'restore journal', `owned by a live process (pid ${journal.pid})`, 'nothing to do; it clears when that process exits cleanly');
    return;
  }
  if (!FIX) {
    add('WARN', 'restore journal', `left behind by pid ${journal.pid}; the device may still be in mode ${journal.mode ?? '?'}`, `node ${join('mcp-linkr', 'index.js')} --restore-mode (or rerun with --fix)`);
    return;
  }
  const healed = await healJournal(journal);
  if (healed.ok) add('PASS', 'restore journal', `healed a journal left by pid ${journal.pid}; device back to mode ${healed.mode}`);
  else add('WARN', 'restore journal', `left behind by pid ${journal.pid}; could not heal: ${healed.reason}`, `node ${join('mcp-linkr', 'index.js')} --restore-mode once the device is reachable`);
}

/** Restore the device mode from the journal using the saved credentials. */
async function healJournal(journal) {
  if (NO_DEVICE) return { ok: false, reason: 'device checks are off (--no-device)' };
  if (!(await exists(passwordFile))) return { ok: false, reason: 'no password file' };
  const password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  const username = (await exists(usernameFile)) ? (await readFile(usernameFile, 'utf8')).trim() : process.env.LINKR_USERNAME ?? '';
  if (username === '') return { ok: false, reason: 'no device account name' };
  try {
    const result = await recoverStaleSession(
      { baseUrl: baseUrl || journal.origin, username, password },
      () => {},
    );
    return result.recovered ? { ok: true, mode: result.mode } : { ok: false, reason: result.reason };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

async function checkDevice() {
  if (NO_DEVICE) {
    add('SKIP', 'device', 'skipped (--no-device)');
    return;
  }
  if (!(await exists(passwordFile))) {
    add('SKIP', 'device', 'no password file, cannot log in');
    return;
  }
  const env = {
    LINKR_BASE_URL: baseUrl,
    LINKR_PASSWORD_FILE: passwordFile,
    LINKR_STATE_DIR: stateDir,
  };
  if (process.env.LINKR_USERNAME) env.LINKR_USERNAME = process.env.LINKR_USERNAME;
  const result = await run(process.execPath, [SERVER, '--status'], { env });
  const text = clean(result.stdout);
  if (result.ok) {
    const deviceLine = text.split('\n').find((line) => line.startsWith('  device:')) ?? '';
    add('PASS', 'device', deviceLine.trim() || text.split('\n')[0] || baseUrl);
  } else {
    const problem = text.split('\n').find((line) => line.startsWith('problem:')) ?? text.split('\n')[0] ?? `${baseUrl} unreachable`;
    add('FAIL', 'device', `cannot read ${baseUrl}: ${problem.replace(/^problem:\s*/, '').slice(0, 160)}`, 'check LINKR_BASE_URL and the password file');
  }
}

async function checkHarnesses() {
  // Codex
  if (await hasCommand('codex')) {
    const list = await run('codex', ['mcp', 'list']);
    const text = clean(`${list.stdout}\n${list.stderr}`);
    if (/^linkr\s/m.test(text)) add('PASS', 'codex', 'linkr MCP server configured');
    else add('WARN', 'codex', 'installed but no linkr MCP entry', 'node scripts/setup.mjs --harness codex --username <account> --password-file <file>');
  } else {
    add('SKIP', 'codex', 'not installed');
  }

  // OpenCode / MiMoCode: both read a project config and expose `mcp list`.
  for (const [command, harness, file] of [
    ['opencode', 'opencode', 'opencode.json'],
    ['mimo', 'mimocode', 'mimocode.json'],
  ]) {
    if (!(await hasCommand(command))) {
      const projectFile = await exists(join(process.cwd(), file));
      if (projectFile) add('WARN', harness, `installed config found (${file}) but ${command} is not on PATH`);
      else add('SKIP', harness, 'not installed');
      continue;
    }
    const list = await run(command, ['mcp', 'list'], { cwd: process.cwd() });
    const text = clean(`${list.stdout}\n${list.stderr}`);
    if (/\blinkr\b/.test(text) && /connected/i.test(text)) add('PASS', harness, 'linkr MCP server configured and connected');
    else if (/\blinkr\b/.test(text)) add('WARN', harness, 'linkr configured but not connected', `check the device and run ${command} mcp list again`);
    else add('WARN', harness, 'installed but no linkr MCP entry', `node scripts/setup.mjs --harness ${harness} --username <account> --project .`);
  }

  // MiniMaxCode: no `mcp list` command (0.7.x); only its files can be checked.
  {
    const userFile = process.env.MINIMAX_DATA_DIR
      ? join(process.env.MINIMAX_DATA_DIR, 'mcp.json')
      : join(homedir(), '.minimax', 'mcp.json');
    const projectFile = join(process.cwd(), '.mcp.json');
    if (await exists(userFile)) add('PASS', 'minimaxcode', `user config ${userFile}`);
    else if (await exists(projectFile)) add('PASS', 'minimaxcode', `project config ${projectFile}`);
    else add('WARN', 'minimaxcode', 'no mcp.json found', 'node scripts/setup.mjs --harness minimaxcode --username <account> (or --project .)');
  }
}

/* ---------------- main ---------------- */

async function main() {
  add('PASS', 'harness-linkr repository', ROOT);
  await checkRuntime();
  await checkCredentials();
  await checkJournal();
  await checkDevice();
  await checkHarnesses();

  const counts = report.reduce((acc, entry) => ({ ...acc, [entry.level]: (acc[entry.level] ?? 0) + 1 }), {});
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: !counts.FAIL, counts, report }, null, 2));
  } else {
    console.log(`\n${counts.PASS ?? 0} pass, ${counts.WARN ?? 0} warn, ${counts.FAIL ?? 0} fail, ${counts.SKIP ?? 0} skipped`);
    const fixes = report.filter((entry) => entry.fix);
    if (fixes.length > 0) {
      console.log('\nNext steps:');
      for (const entry of fixes) console.log(`  - ${entry.name}: ${entry.fix}`);
    }
  }
  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((error) => {
  console.error(`doctor failed: ${error.message}`);
  process.exit(1);
});
