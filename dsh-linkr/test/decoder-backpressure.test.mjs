#!/usr/bin/env node
/**
 * A stalled H.264 decoder must not let the packet stream grow without bound.
 * Live video is disposable: media.js drops packets while ffmpeg's stdin is
 * backed up (one writer per frame, resumed on 'drain') and counts them in
 * `stats.dropped`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { findFfmpeg } from '../lib/ffmpeg.js';
import { LinkrDevice } from '../lib/linkr.js';
import { MediaSession } from '../lib/media.js';
import { createFakeDevice } from './fake-device.mjs';

const FFMPEG = findFfmpeg();
const gate = FFMPEG ? false : 'ffmpeg not found; decoder backpressure test skipped';

/**
 * Synthetic AnnexB units: the stalled decoder never parses them, but the fake
 * device splits on start codes and streams enough bytes to fill a pipe.
 */
function syntheticClip() {
  const units = [];
  for (let i = 0; i < 300; i += 1) {
    const nal = Buffer.alloc(1024, i & 0xff);
    nal[4] = i % 2 === 0 ? 0x65 : 0x41; // IDR-ish / non-IDR markers
    units.push(Buffer.from([0x00, 0x00, 0x00, 0x01]), nal);
  }
  return Buffer.concat(units);
}

/** An "ffmpeg" that never reads stdin, so the pipe fills and writes return false. */
function stalledFfmpeg(t) {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-stalled-ffmpeg-'));
  const file = join(dir, 'ffmpeg');
  writeFileSync(file, '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  chmodSync(file, 0o755);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

test('a stalled decoder drops packets instead of queueing them', { skip: gate }, async (t) => {
  const clip = syntheticClip();
  const fake = createFakeDevice({ initialCodec: 2, h264Clip: clip, h264PacketIntervalMs: 1 });
  const origin = await fake.listen();
  const device = new LinkrDevice({ baseUrl: origin, username: 'tester', password: 's3cret' });
  const session = new MediaSession(device, { codec: 'h264', ffmpegPath: stalledFfmpeg(t) });
  t.after(async () => {
    session.stop();
    device.dispose();
    await fake.close();
  });

  await assert.rejects(session.start({ timeoutMs: 1500 }));
  // The fake device keeps pushing packets while ffmpeg never reads them.
  const deadline = Date.now() + 4000;
  while (session.stats.dropped === 0 && Date.now() < deadline) await sleep(20);
  assert.ok(session.stats.dropped > 0, `packets were dropped (packets=${session.stats.packets}, dropped=${session.stats.dropped})`);
});
