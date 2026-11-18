/**
 * ffmpeg discovery and the one decoder child the H.264 path needs (CONTRACT.md §7.2).
 *
 * The device sends H.264 AnnexB over the same media websocket; ffmpeg is the only
 * thing that turns that into JPEGs for the existing frame pipeline.
 *
 * Discovery order (first runnable wins):
 *   1. explicit path (plugin config `ffmpegPath`)
 *   2. $FFMPEG_PATH
 *   3. /opt/homebrew/bin/ffmpeg   (the macOS default install)
 *   4. `ffmpeg` on $PATH
 *
 * `LINKR_NO_FFMPEG=1` disables discovery entirely (force the MJPEG path on a box
 * where ffmpeg must not run).
 *
 * Node built-ins only.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { LinkrError } from './linkr.js';

/** Places a Homebrew/usr-local install puts the binary. */
export const FFMPEG_CANDIDATES = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];

/** ffmpeg `-q:v` range the contract allows (1 = best quality, 10 = smallest). */
export const JPEG_QUALITY_RANGE = [1, 10];
export const DEFAULT_JPEG_QUALITY = 4;

export function clampJpegQuality(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_JPEG_QUALITY;
  return Math.min(JPEG_QUALITY_RANGE[1], Math.max(JPEG_QUALITY_RANGE[0], n));
}

function isRunnableFile(candidate) {
  try {
    const info = statSync(candidate);
    if (!info.isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fromPath(name, pathValue) {
  if (!name.includes('/')) {
    for (const dir of String(pathValue ?? '').split(delimiter)) {
      if (!dir) continue;
      const full = join(dir, name);
      if (isRunnableFile(full)) return full;
    }
    return null;
  }
  return isRunnableFile(name) ? name : null;
}

/**
 * Resolve an ffmpeg binary.
 *
 * @param {string} [explicitPath] config value; empty means "use the search order"
 * @param {{ env?: NodeJS.ProcessEnv, candidates?: string[] }} [options]
 * @returns {string | null} absolute (or PATH-resolved) path, or null when none runs
 */
export function findFfmpeg(explicitPath = '', options = {}) {
  const env = options.env ?? process.env;
  const candidates = options.candidates ?? FFMPEG_CANDIDATES;
  if (env.LINKR_NO_FFMPEG === '1') return null;

  const wanted = String(explicitPath ?? '').trim();
  if (wanted) {
    const found = isRunnableFile(wanted) ? wanted : fromPath(wanted, env.PATH);
    if (found) return found;
  }
  const fromEnv = String(env.FFMPEG_PATH ?? '').trim();
  if (fromEnv) {
    const found = isRunnableFile(fromEnv) ? fromEnv : fromPath(fromEnv, env.PATH);
    if (found) return found;
  }
  for (const candidate of candidates) {
    if (isRunnableFile(candidate)) return candidate;
  }
  return fromPath('ffmpeg', env.PATH);
}

/** True when an H.264 → JPEG decode is possible on this machine. */
export function ffmpegAvailable(explicitPath = '', options = {}) {
  return findFfmpeg(explicitPath, options) !== null;
}

/**
 * The decoder command line proven against the device in CONTRACT.md §7.2:
 *
 *   ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay \
 *          -f h264 -i pipe:0 -an -f image2pipe -vcodec mjpeg -q:v <q> pipe:1
 */
export function decoderArgs(jpegQuality = DEFAULT_JPEG_QUALITY) {
  const quality = clampJpegQuality(jpegQuality);
  return [
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
    String(quality),
    'pipe:1',
  ];
}

/**
 * Spawn the decoder with pipes on stdin/stdout/stderr.
 *
 * @param {{ ffmpegPath?: string, jpegQuality?: number }} [options]
 * @returns {{ child: import('node:child_process').ChildProcess, path: string, args: string[] }}
 */
export function spawnDecoder({ ffmpegPath = '', jpegQuality = DEFAULT_JPEG_QUALITY } = {}) {
  const path = findFfmpeg(ffmpegPath);
  if (!path) {
    throw new LinkrError('ffmpeg not found', {
      sentence:
        'H.264 needs ffmpeg and none was found (looked at ffmpegPath, $FFMPEG_PATH, /opt/homebrew/bin/ffmpeg and PATH): install ffmpeg or switch the codec to MJPEG',
    });
  }
  const args = decoderArgs(jpegQuality);
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, path, args };
}
