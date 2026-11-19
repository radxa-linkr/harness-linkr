/**
 * Stale-session journal, shared by every harness integration.
 *
 * A process writes the device's previous video mode here before it switches the
 * device-wide `video_codec`, and removes the record after restoring it. If the
 * harness kills the server instead of closing it, the next start can heal the
 * device from this file. One record per device origin, named after the origin
 * hash; the legacy unnamed file is still read for compatibility.
 *
 * Node built-ins only: this module is part of the transport and is copied into
 * the plugin packages by scripts/sync-core.mjs.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { normalizeOrigin } from './linkr.js';

export function stateDirectory() {
  return process.env.LINKR_STATE_DIR || join(homedir(), '.linkr');
}

export function journalPath(origin = '') {
  const suffix = origin ? `-${createHash('sha256').update(normalizeOrigin(origin)).digest('hex').slice(0, 24)}` : '';
  return join(stateDirectory(), `mcp-session${suffix}.json`);
}

export function sameOrigin(left, right) {
  try {
    return normalizeOrigin(left) === normalizeOrigin(right);
  } catch {
    return false;
  }
}

/** Read the journal; undefined when absent or unreadable. */
async function readEntry(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
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
  const tmp = `${path}.tmp-${process.pid}-${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)}`;
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

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}
