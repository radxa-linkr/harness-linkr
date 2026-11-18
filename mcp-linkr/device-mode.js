/**
 * Stale-session recovery for harnesses that kill the MCP server.
 *
 * A harness starts the server, the server switches the device's global
 * `video_codec` for a live session, and the harness may then SIGKILL the server
 * instead of closing stdin. The device would stay in that mode, breaking every
 * other client. So the mode that must be restored is journalled on disk before
 * the switch, and a later server start (or `--restore-mode`) heals a journal
 * whose owner process is gone.
 *
 * The journal is per device origin and contains its writer's pid.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { hashPassword, normalizeOrigin } from '../dsh-linkr/lib/linkr.js';
import { acquireDeviceLease } from './device-lease.js';

const REQUEST_TIMEOUT_MS = 8000;

export function stateDirectory() {
  return process.env.LINKR_STATE_DIR || join(homedir(), '.linkr');
}

export function journalPath(origin = '') {
  const suffix = origin ? `-${createHash('sha256').update(normalizeOrigin(origin)).digest('hex').slice(0, 24)}` : '';
  return join(stateDirectory(), `mcp-session${suffix}.json`);
}

function sameOrigin(left, right) {
  try {
    return normalizeOrigin(left) === normalizeOrigin(right);
  } catch {
    return false;
  }
}

/** Read the journal; undefined when absent or unreadable. */
async function readEntry(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function findJournal(origin = '') {
  const path = journalPath(origin);
  const entry = await readEntry(path);
  if (entry) return { path, entry };
  if (origin) {
    const legacy = await readEntry(journalPath());
    if (legacy && sameOrigin(legacy.origin, origin)) return { path: journalPath(), entry: legacy };
  }
  return undefined;
}

export async function readJournal(origin = '') {
  return (await findJournal(origin))?.entry;
}

export async function readJournals() {
  const names = await readdir(stateDirectory()).catch(() => []);
  const entries = await Promise.all(names.filter(name => /^mcp-session(?:-[a-f0-9]{24})?\.json$/.test(name))
    .map(name => readEntry(join(stateDirectory(), name))));
  return entries.filter(Boolean);
}

/** Write the journal atomically (temp file + rename). */
export async function writeJournal(entry) {
  const path = journalPath(entry.origin);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/** Remove the journal, but only when it is still ours (or when forced). */
export async function clearJournal({ pid = process.pid, force = false, origin = '' } = {}) {
  const found = await findJournal(origin);
  const current = found?.entry;
  if (current !== undefined && !force && current.pid !== undefined && current.pid !== pid) return false;
  if (found) await rm(found.path, { force: true });
  return true;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

/* ---------------- device mode over plain HTTP ---------------- */

function deviceEndpoint(config, path) {
  const origin = normalizeOrigin(config.baseUrl || '');
  if (!origin) throw new Error('LINKR_BASE_URL is required');
  return `${origin}${path}`;
}

async function login(config) {
  const response = await fetch(deviceEndpoint(config, '/api/account/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, passwd: hashPassword(config.password) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  const token = payload?.data?.token;
  if (!response.ok || typeof token !== 'string' || token === '') {
    throw new Error(`device login failed (${response.status})`);
  }
  return token;
}

/** Current device `video_codec`, or undefined when it cannot be read. */
export async function readDeviceMode(config) {
  const token = await login(config);
  const response = await fetch(deviceEndpoint(config, '/api/video/codec'), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  const mode = payload?.data?.video_codec;
  if (!response.ok || payload?.code !== 0 || !Number.isInteger(mode)) throw new Error('could not read the device video mode');
  return mode;
}

/** Set the device `video_codec`; returns the mode the device reports after it. */
export async function writeDeviceMode(config, mode) {
  const token = await login(config);
  const response = await fetch(deviceEndpoint(config, '/api/video/codec'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_codec: mode }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`could not set the device video mode to ${mode} (HTTP ${response.status})`);
  }
  return readDeviceMode(config);
}

/**
 * Heal a journal left by a dead server for this device.
 *
 * Returns `{ recovered, mode, reason }`; never throws for a missing journal or
 * an unreachable device (both are reported as `recovered: false`).
 */
export async function recoverStaleSession(config, log = () => {}, { leaseHeld = false } = {}) {
  let release;
  if (!leaseHeld) {
    try { release = await acquireDeviceLease(config.baseUrl); }
    catch (error) { return { recovered: false, reason: error.message }; }
  }
  try { return await recoverUnderLease(config, log); }
  finally { await release?.(); }
}

async function recoverUnderLease(config, log) {
  const journal = await readJournal(config.baseUrl);
  if (journal === undefined) return { recovered: false, reason: 'no journal' };
  if (!sameOrigin(journal.origin, config.baseUrl)) {
    return { recovered: false, reason: `journal belongs to ${journal.origin}` };
  }
  if (journal.pid === process.pid) {
    return { recovered: false, reason: 'journal belongs to this process' };
  }
  if (Number.isInteger(journal.pid) && pidAlive(journal.pid)) {
    return { recovered: false, reason: `session still owned by pid ${journal.pid}` };
  }
  if (!Number.isFinite(journal.baselineMode)) {
    await clearJournal({ force: true, origin: config.baseUrl });
    return { recovered: false, reason: 'journal has no baseline mode' };
  }
  try {
    const mode = await writeDeviceMode(config, journal.baselineMode);
    if (mode !== journal.baselineMode) throw new Error('device did not confirm the restored video mode');
    await clearJournal({ force: true, origin: config.baseUrl });
    log(`restored the device video mode to ${mode} after an unclean shutdown`);
    return { recovered: true, mode };
  } catch (error) {
    log(`could not restore the device video mode: ${error.message}`);
    return { recovered: false, reason: error.message };
  }
}
