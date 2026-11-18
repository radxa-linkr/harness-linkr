/**
 * Environment configuration for the Linkr MCP server.
 *
 * Every harness config (Codex TOML, OpenCode/MiMo JSON, MiniMaxCode) only sets
 * these variables, so one implementation serves all of them.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve a path with a leading `~/` against the home directory. */
function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function text(env, key, fallback = '') {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function number(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function flag(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return fallback;
}

/**
 * The password, in order: `LINKR_PASSWORD`, `LINKR_PASSWORD_FILE`, then the
 * DSH-style credentials JSON (`LINKR_CREDENTIALS_FILE`), then empty.
 *
 * Empty means "not configured": the tools answer with the fix instead of
 * failing with an opaque auth error.
 */
function readPassword(env) {
  const direct = env.LINKR_PASSWORD;
  if (typeof direct === 'string' && direct !== '') return direct;

  const file = text(env, 'LINKR_PASSWORD_FILE');
  if (file !== '') {
    const path = expandHome(file);
    try {
      return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch {
      return '';
    }
  }

  const credentials = text(env, 'LINKR_CREDENTIALS_FILE');
  if (credentials !== '') {
    const path = expandHome(credentials);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const entry = parsed?.linkr ?? parsed;
      const value = entry?.password ?? entry?.payload?.password;
      if (typeof value === 'string') return value;
    } catch {
      /* a broken or absent file is simply "no password" */
    }
  }
  return '';
}

/** Which source supplied the password (never the value itself). */
export function passwordSource(env = process.env) {
  if (typeof env.LINKR_PASSWORD === 'string' && env.LINKR_PASSWORD !== '') return 'LINKR_PASSWORD';
  if (text(env, 'LINKR_PASSWORD_FILE') !== '') return 'LINKR_PASSWORD_FILE';
  if (text(env, 'LINKR_CREDENTIALS_FILE') !== '') return 'LINKR_CREDENTIALS_FILE';
  return 'none';
}

export function readConfig(env = process.env) {
  let saved = {};
  const file = expandHome(text(env, 'LINKR_CONFIG_FILE', join(homedir(), '.linkr', 'config.json')));
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value;
  } catch { /* optional local plugin configuration; missing values are diagnosed below */ }
  const resolved = { ...env };
  for (const [key, field] of [['LINKR_BASE_URL', 'baseUrl'], ['LINKR_USERNAME', 'username'], ['LINKR_PASSWORD_FILE', 'passwordFile'],
    ['LINKR_CODEC', 'codec'], ['LINKR_STREAM_FPS', 'streamFps'], ['LINKR_JPEG_QUALITY', 'jpegQuality'], ['LINKR_FFMPEG_PATH', 'ffmpegPath']]) {
    if (!resolved[key] && ['string', 'number'].includes(typeof saved[field])) resolved[key] = String(saved[field]);
  }
  const saveDir = expandHome(text(env, 'LINKR_SAVE_DIR', join(homedir(), '.linkr', 'captures')));
  const codec = text(resolved, 'LINKR_CODEC', 'auto').toLowerCase();
  return {
    settingsFile: file,
    client: {
      baseUrl: text(resolved, 'LINKR_BASE_URL'),
      username: text(resolved, 'LINKR_USERNAME'),
      password: readPassword(resolved),
      codec: ['auto', 'mjpeg', 'h264'].includes(codec) ? codec : 'auto',
      ffmpegPath: text(resolved, 'LINKR_FFMPEG_PATH'),
      jpegQuality: number(resolved, 'LINKR_JPEG_QUALITY', 4),
      fps: number(resolved, 'LINKR_STREAM_FPS', 20),
      idleStopMs: number(env, 'LINKR_IDLE_STOP_MS', 120000),
      manageVideoMode: flag(env, 'LINKR_MANAGE_VIDEO_MODE', true),
    },
    saveDir,
    /** Inline image blocks in tool results (harnesses with vision support). */
    inlineImages: flag(env, 'LINKR_INLINE_IMAGES', true),
    /** Largest inline image, base64 payload bytes. */
    inlineMaxBytes: number(env, 'LINKR_INLINE_MAX_BYTES', 4 * 1024 * 1024),
    /** Trace MCP frames to stderr when debugging a harness integration. */
    debug: flag(env, 'LINKR_MCP_DEBUG', false),
    /** Append the same trace to this file (lets a harness's client be observed). */
    logFile: text(env, 'LINKR_MCP_LOG_FILE'),
    /** For --check-config: where the password came from, never the password. */
    passwordSource: passwordSource(resolved),
  };
}
