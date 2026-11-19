#!/usr/bin/env node
/**
 * The session-end callback: the MCP server releases its device lease only when
 * the device video mode was actually restored. A failed restore must report
 * `restored: false` and keep the mode debt (so the lease stays held).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const scratch = mkdtempSync(join(tmpdir(), 'linkr-session-end-'));
process.env.LINKR_STATE_DIR = scratch;

const { createFakeDevice } = await import('./fake-device.mjs');
const { LinkrClient } = await import('../lib/index.js');
const { clearJournal, writeJournal } = await import('../lib/journal.js');

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

const fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 0 });
await fake.listen();
const ends = [];
function makeClient(extra = {}) {
  return new LinkrClient({
    baseUrl: fake.origin,
    username: 'tester',
    password: 's3cret',
    codec: 'mjpeg',
    manageVideoMode: true,
    fps: 5,
    beforeVideoModeChange: ({ origin, priorMode, targetMode }) =>
      writeJournal({ pid: process.pid, origin, baselineMode: priorMode, mode: targetMode, at: Date.now() }),
    afterVideoModeRestore: ({ origin }) => clearJournal({ pid: process.pid, force: false, origin }),
    onSessionEnd: ({ reason, restored }) => ends.push({ reason, restored }),
    ...extra,
  });
}
const client = makeClient();

try {
  await check('a successful restore reports restored:true', async () => {
    await client.connect();
    assert.equal(fake.codec, 1);
    await client.disconnect();
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: true });
    assert.equal(fake.codec, 0);
  });

  await check('a failed restore reports restored:false and keeps the debt', async () => {
    await client.connect();
    assert.equal(fake.codec, 1);
    fake.codecWriteFails = true;
    await client.disconnect();
    fake.codecWriteFails = false;
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: false });
    assert.equal(fake.codec, 1, 'the device kept the session mode');
    assert.equal(client.state.modeOwned, true, 'the client still owes the restore');
  });

  await check('the debt is retried on the next teardown', async () => {
    await client.disconnect();
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: true });
    assert.equal(fake.codec, 0);
    assert.equal(client.state.modeOwned, false);
  });

  await check('dispose is idempotent and reports the session end once', async () => {
    const second = makeClient();
    await second.connect();
    assert.equal(fake.codec, 1);
    const before = ends.length;
    await Promise.all([second.dispose(), second.dispose()]);
    assert.equal(ends.length, before + 1, 'two disposes must not report two session ends');
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: true });
    assert.equal(fake.codec, 0);
    await second.disconnect();
    assert.equal(ends.length, before + 1, 'disconnect after dispose is a no-op');
    assert.equal(fake.codec, 0);
  });

  await check('an idle stop that cannot restore keeps the debt until dispose retries', async () => {
    const third = makeClient({ idleStopMs: 150 });
    await third.connect();
    assert.equal(fake.codec, 1);
    fake.codecWriteFails = true;
    await sleep(500);
    fake.codecWriteFails = false;
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: false });
    assert.equal(fake.codec, 1, 'the idle stop could not restore the mode');
    assert.equal(third.state.modeOwned, true);
    await third.dispose();
    assert.deepEqual(ends.at(-1), { reason: 'disconnect', restored: true });
    assert.equal(fake.codec, 0);
  });
} finally {
  await client.dispose().catch(() => {});
  await clearJournal({ force: true, origin: fake.origin });
  await fake.close();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
