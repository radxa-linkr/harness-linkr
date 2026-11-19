#!/usr/bin/env node
/**
 * Stale video-mode recovery shared by both harnesses: the client journal hooks
 * write before a mode switch, and core/recover.js heals a leftover journal even
 * when the pid belongs to the current process (a Cordis reload in place).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'linkr-recovery-'));
process.env.LINKR_STATE_DIR = scratch;

const { createFakeDevice } = await import('./fake-device.mjs');
const { LinkrClient } = await import('../lib/index.js');
const { readJournal, writeJournal, clearJournal } = await import('../lib/journal.js');
const { recoverStaleSession } = await import('../lib/recover.js');

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

const fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 2 });
await fake.listen();

const hooks = {
  beforeVideoModeChange: ({ origin, priorMode, targetMode }) =>
    writeJournal({ pid: process.pid, instance: 'previous-apply', origin, baselineMode: priorMode, mode: targetMode, at: Date.now() }),
  afterVideoModeRestore: ({ origin }) => clearJournal({ pid: process.pid, force: false, origin }),
};
const client = new LinkrClient({
  baseUrl: fake.origin,
  username: 'tester',
  password: 's3cret',
  codec: 'mjpeg',
  manageVideoMode: true,
  fps: 5,
  ...hooks,
});

try {
  await check('a session writes the baseline journal before switching the mode', async () => {
    await client.connect();
    assert.equal(fake.codec, 1, 'the session switched the device to MJPEG');
    const journal = await readJournal(fake.origin);
    assert.ok(journal, 'the journal exists while the session owns the mode');
    assert.equal(journal.baselineMode, 2);
    assert.equal(journal.pid, process.pid);
  });

  await check('recovery restores the baseline mode and clears the journal', async () => {
    // Simulate a killed process: the client is not disposed, so the journal
    // survives. A reload in the same process must still heal it.
    const result = await recoverStaleSession(
      { baseUrl: fake.origin, username: 'tester', password: 's3cret' },
      () => {},
      { allowSamePid: true },
    );
    assert.equal(result.recovered, true, result.reason);
    assert.equal(result.mode, 2);
    assert.equal(fake.codec, 2, 'the device is back in its own mode');
    assert.equal(await readJournal(fake.origin), undefined);
  });

  await check('a non-stale journal is left alone', async () => {
    await writeJournal({ pid: process.ppid, instance: 'another-process', origin: fake.origin, baselineMode: 0, at: Date.now() });
    const result = await recoverStaleSession(
      { baseUrl: fake.origin, username: 'tester', password: 's3cret' },
      () => {},
      { allowSamePid: true },
    );
    assert.equal(result.recovered, false);
    assert.match(result.reason, /still owned by pid/);
    assert.ok(await readJournal(fake.origin));
    await clearJournal({ force: true, origin: fake.origin });
  });
} finally {
  await client.dispose().catch(() => {});
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
