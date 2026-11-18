#!/usr/bin/env node
/**
 * Journal rules behind --restore-mode: which stale records may be healed.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'linkr-mode-journal-'));
process.env.LINKR_STATE_DIR = scratch;

const { clearJournal, journalPath, readJournal, recoverStaleSession, writeJournal } = await import('../device-mode.js');

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

const DEVICE = { baseUrl: 'http://127.0.0.1:1', username: 'tester', password: 's3cret' };

await check('no journal reads as undefined', async () => {
  assert.equal(await readJournal(), undefined);
});

await check('a written journal round-trips', async () => {
  await writeJournal({ pid: 999999, origin: 'http://127.0.0.1:1', baselineMode: 0, at: Date.now() });
  const journal = await readJournal(DEVICE.baseUrl);
  assert.equal(journal.baselineMode, 0);
  assert.equal(journal.pid, 999999);
});

await check('clearJournal refuses a record owned by another pid', async () => {
  assert.equal(await clearJournal({ pid: process.pid, origin: DEVICE.baseUrl }), false);
  assert.ok(await readJournal(DEVICE.baseUrl));
});

await check('recovery skips a journal for a different device', async () => {
  await clearJournal({ force: true, origin: DEVICE.baseUrl });
  await writeJournal({ pid: 999999, origin: 'http://linkr.local', baselineMode: 0, at: Date.now() });
  const result = await recoverStaleSession(DEVICE);
  assert.equal(result.recovered, false);
  assert.equal(result.reason, 'no journal');
  assert.ok(await readJournal('http://linkr.local'));
});

await check('recovery skips a journal owned by this very process', async () => {
  await writeJournal({ pid: process.pid, origin: DEVICE.baseUrl, baselineMode: 0, at: Date.now() });
  const result = await recoverStaleSession(DEVICE);
  assert.equal(result.recovered, false);
  assert.match(result.reason, /belongs to this process/);
});

await check('recovery skips a journal whose owner process is alive', async () => {
  await writeJournal({ pid: process.ppid, origin: DEVICE.baseUrl, baselineMode: 0, at: Date.now() });
  const result = await recoverStaleSession(DEVICE);
  assert.equal(result.recovered, false);
  assert.match(result.reason, /still owned by pid/);
});

await check('forced clear removes any journal', async () => {
  assert.equal(await clearJournal({ force: true, origin: DEVICE.baseUrl }), true);
  assert.equal(await readJournal(DEVICE.baseUrl), undefined);
  assert.ok(journalPath().startsWith(scratch));
});

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
