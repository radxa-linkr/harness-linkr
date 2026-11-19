/** Private local login settings. Passwords never enter MCP tool arguments/results. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export class SettingsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function settingsFile(config) {
  return config.settingsFile || join(homedir(), '.linkr', 'config.json');
}

export function publicSettings(config) {
  const c = config.client;
  return {
    baseUrl: c.baseUrl || '',
    username: c.username || '',
    passwordSaved: Boolean(c.password),
    codec: c.codec || 'auto',
    streamFps: c.fps || 20,
    jpegQuality: c.jpegQuality || 4,
    ffmpegPath: c.ffmpegPath || '',
  };
}

export function loginCandidate(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new SettingsError('登录设置格式不正确。');
  let url;
  try {
    url = new URL(String(body.baseUrl || '').trim());
  } catch {
    throw new SettingsError('请输入完整设备地址，例如 http://linkr.local。');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  ) {
    throw new SettingsError(
      '设备地址须为 HTTP 或 HTTPS 地址，不包含账号、路径或查询参数。',
    );
  }
  const username =
    typeof body.username === 'string' ? body.username.trim() : '';
  if (!username || username.length > 128)
    throw new SettingsError('请输入设备用户名（最多 128 个字符）。');
  let previousOrigin = '';
  try {
    previousOrigin = new URL(config.client.baseUrl).origin;
  } catch {
    /* unconfigured */
  }
  const sameIdentity =
    url.origin === previousOrigin && username === config.client.username;
  if (body.password !== undefined && typeof body.password !== 'string')
    throw new SettingsError('密码格式不正确。');
  const supplied = typeof body.password === 'string' ? body.password : '';
  if (supplied.length > 4096)
    throw new SettingsError('密码长度不能超过 4096 个字符。');
  const password = supplied || (sameIdentity ? config.client.password : '');
  if (!password)
    throw new SettingsError(
      sameIdentity
        ? '请输入设备密码。'
        : '更换设备或用户名时，请重新输入密码。',
    );
  const codec = body.codec ?? config.client.codec ?? 'auto';
  if (!['auto', 'mjpeg', 'h264'].includes(codec))
    throw new SettingsError('请选择有效的编码格式。');
  const integer = (value, fallback, min, max, label) => {
    const number = Number(value ?? fallback);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new SettingsError(`${label}须为 ${min}–${max} 的整数。`);
    return number;
  };
  const ffmpegPath =
    typeof body.ffmpegPath === 'string'
      ? body.ffmpegPath.trim()
      : config.client.ffmpegPath || '';
  if (ffmpegPath.length > 4096 || ffmpegPath.includes('\0'))
    throw new SettingsError('ffmpeg 路径不正确。');
  return {
    ...config.client,
    baseUrl: url.origin,
    username,
    password,
    codec,
    fps: integer(body.streamFps, config.client.fps || 20, 1, 60, '帧率'),
    jpegQuality: integer(
      body.jpegQuality,
      config.client.jpegQuality || 4,
      1,
      10,
      'JPEG 质量',
    ),
    ffmpegPath,
  };
}

/** Stage a new private credential and config; the caller commits after restoring the old session. */
export async function stageSettings(config, next) {
  const file = settingsFile(config);
  const credentialsDir = join(dirname(file), 'credentials');
  const passwordFile = next.password
    ? join(credentialsDir, `linkr-${randomUUID()}.secret`)
    : '';
  const tmp = `${file}.tmp-${randomUUID()}`;
  let committed = false;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(file, 'utf8'));
    if (!previous || typeof previous !== 'object' || Array.isArray(previous))
      throw new Error('invalid settings');
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new SettingsError('无法读取本机登录配置，请检查配置文件。', 500);
  }
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    if (passwordFile) {
      await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
      await writeFile(passwordFile, `${next.password}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    }
    const safe = {
      baseUrl: next.baseUrl,
      username: next.username,
      codec: next.codec,
      streamFps: next.fps,
      jpegQuality: next.jpegQuality,
      ffmpegPath: next.ffmpegPath,
      ...(passwordFile ? { passwordFile } : {}),
    };
    await writeFile(tmp, `${JSON.stringify(safe, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    if (passwordFile) await rm(passwordFile, { force: true }).catch(() => {});
    throw new SettingsError('无法保存本机登录配置，请检查目录写入权限。', 500);
  }
  const removeOwned = async (old) => {
    if (
      typeof old === 'string' &&
      dirname(resolve(old)) === resolve(credentialsDir) &&
      /^linkr-[a-f0-9-]+\.secret$/.test(old.split(/[\\/]/).pop())
    ) {
      await rm(old, { force: true }).catch(() => {});
    }
  };
  return {
    passwordFile,
    async commit() {
      try {
        await rename(tmp, file);
        committed = true;
      } catch {
        throw new SettingsError(
          '无法保存本机登录配置，请检查目录写入权限。',
          500,
        );
      }
      await removeOwned(previous.passwordFile);
    },
    async rollback() {
      if (committed) return;
      await rm(tmp, { force: true }).catch(() => {});
      if (passwordFile) await removeOwned(passwordFile);
    },
  };
}
