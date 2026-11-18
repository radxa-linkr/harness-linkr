/**
 * ffmpeg discovery and the decoder command line (CONTRACT.md §7.2). No device and
 * no real ffmpeg needed for most of this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findFfmpeg,
  ffmpegAvailable,
  decoderArgs,
  clampJpegQuality,
  spawnDecoder,
  DEFAULT_JPEG_QUALITY,
} from '../lib/ffmpeg.js';
import { LinkrError } from '../lib/linkr.js';

function makeExecutable(dir, name = 'ffmpeg') {
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

test('the decoder command line is the one proven against the device', () => {
  assert.deepEqual(decoderArgs(4), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-fflags',
    'nobuffer',
    '-flags',
    'low_delay',
    '-f',
    'h264',
    '-i',
    'pipe:0',
    '-an',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-q:v',
    '4',
    'pipe:1',
  ]);
  assert.equal(decoderArgs(1).at(-2), '1');
  assert.equal(decoderArgs(99).at(-2), '10');
  assert.equal(DEFAULT_JPEG_QUALITY, 4);
});

test('jpeg quality is clamped to the 1..10 the device contract allows', () => {
  assert.equal(clampJpegQuality(0), 1);
  assert.equal(clampJpegQuality(-3), 1);
  assert.equal(clampJpegQuality(4), 4);
  assert.equal(clampJpegQuality(99), 10);
  assert.equal(clampJpegQuality('7'), 7);
  assert.equal(clampJpegQuality('nope'), DEFAULT_JPEG_QUALITY);
});

test('discovery returns null when nothing runnable exists', () => {
  assert.equal(findFfmpeg('', { env: { PATH: '' }, candidates: [] }), null);
  assert.equal(findFfmpeg('/definitely/not/ffmpeg', { env: { PATH: '' }, candidates: [] }), null);
  assert.equal(ffmpegAvailable('', { env: { PATH: '' }, candidates: [] }), false);
});

test('discovery order: explicit path, then $FFMPEG_PATH, then the candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linkr-ffmpeg-'));
  try {
    const explicit = makeExecutable(dir, 'ffmpeg-explicit');
    const fromEnv = makeExecutable(dir, 'ffmpeg-env');
    const candidate = makeExecutable(dir, 'ffmpeg-candidate');

    assert.equal(
      findFfmpeg(explicit, { env: { PATH: '', FFMPEG_PATH: fromEnv }, candidates: [candidate] }),
      explicit,
    );
    assert.equal(
      findFfmpeg('', { env: { PATH: '', FFMPEG_PATH: fromEnv }, candidates: [candidate] }),
      fromEnv,
    );
    assert.equal(findFfmpeg('', { env: { PATH: '' }, candidates: [candidate] }), candidate);
    // A bare name is resolved through $PATH.
    assert.equal(
      findFfmpeg('ffmpeg-explicit', { env: { PATH: dir }, candidates: [] }),
      explicit,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LINKR_NO_FFMPEG disables discovery even when ffmpeg is installed', () => {
  assert.equal(findFfmpeg('', { env: { PATH: '', LINKR_NO_FFMPEG: '1' }, candidates: [] }), null);
});

test('spawnDecoder refuses to run without a binary and explains the fix', () => {
  const previous = process.env.LINKR_NO_FFMPEG;
  process.env.LINKR_NO_FFMPEG = '1';
  try {
    assert.throws(() => spawnDecoder({ ffmpegPath: '' }), (error) => {
      assert.ok(error instanceof LinkrError);
      assert.match(error.sentence, /H\.264 needs ffmpeg/);
      assert.match(error.sentence, /MJPEG/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.LINKR_NO_FFMPEG;
    else process.env.LINKR_NO_FFMPEG = previous;
  }
});

test('when ffmpeg exists, discovery finds a runnable binary', (t) => {
  const found = findFfmpeg();
  if (!found) {
    t.skip('ffmpeg is not installed here');
    return;
  }
  assert.ok(found.length > 0);
  assert.equal(ffmpegAvailable(), true);
  const { child, path } = spawnDecoder({ jpegQuality: 6 });
  try {
    assert.equal(path, found);
    assert.deepEqual(child.spawnargs.slice(-2), ['6', 'pipe:1']);
  } finally {
    child.kill('SIGKILL');
  }
});
