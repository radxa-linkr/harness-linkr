/**
 * Saved connection settings for the OpenCode plugin.
 *
 * The panel's settings form writes here (0600, under `~/.linkr/`), and the
 * plugin merges the file over its `opencode.json` options and the `LINKR_*`
 * environment when it builds the device configuration. `saveSettings` keeps the
 * password in this file only when the user types a new one; the form can also
 * leave it blank to keep the current credential.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SETTINGS_VERSION = 1;
export const CODECS = ['auto', 'mjpeg', 'h264'];

/** `~/.linkr/opencode-plugin.json`. */
export function settingsFile(home = homedir()) {
  return join(home, '.linkr', 'opencode-plugin.json');
}

/** Keep only the known, non-empty string fields (and a valid codec). */
export function sanitizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of ['baseUrl', 'username', 'password', 'codec']) {
    const field = value[key];
    if (typeof field === 'string' && field.trim() !== '') out[key] = field.trim();
  }
  if (out.codec !== undefined && !CODECS.includes(out.codec)) delete out.codec;
  return out;
}

export async function readSettings(file = settingsFile()) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return sanitizeSettings(parsed);
  } catch {
    return {};
  }
}

export async function writeSettings(next, file = settingsFile()) {
  const value = { version: SETTINGS_VERSION, ...sanitizeSettings(next) };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return value;
}

/** What the panel may show about the effective configuration (never the password). */
export function publicSettings(config, saved = {}) {
  const password = typeof config?.client?.password === 'string' ? config.client.password : '';
  return {
    baseUrl: config?.client?.baseUrl ?? '',
    username: config?.client?.username ?? '',
    codec: config?.client?.codec ?? 'auto',
    hasPassword: password !== '',
    passwordSaved: typeof saved?.password === 'string' && saved.password !== '',
    passwordSource: saved?.password ? 'settings' : password !== '' ? 'environment' : '',
  };
}

/** Validate one patch from the settings form; throws a sentence the panel can show. */
export function validatePatch(patch) {
  const value = patch && typeof patch === 'object' ? patch : {};
  const out = sanitizeSettings(value);
  if (value.password === '') delete out.password;
  if (out.baseUrl !== undefined) {
    let url;
    try {
      url = new URL(out.baseUrl);
    } catch {
      throw new Error('设备地址必须是完整 URL，例如 http://linkr.local');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('设备地址必须是 http:// 或 https://');
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('设备地址只写到主机和端口，不要带路径');
    out.baseUrl = url.origin;
  }
  if (out.username !== undefined && out.username === '') throw new Error('账号不能为空');
  if (out.codec !== undefined && !CODECS.includes(out.codec)) throw new Error('编码格式必须是 auto / mjpeg / h264');
  for (const key of Object.keys(value)) {
    if (!['baseUrl', 'username', 'password', 'codec'].includes(key)) throw new Error(`不支持的设置项 ${key}`);
  }
  return out;
}
