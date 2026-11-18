/**
 * Row config of the dsh-linkr Host half.
 *
 * Every key this plugin reads, the defaults the patch row also carries, the
 * normalisation a saved write goes through, and the standard-schema face the
 * Loader validates with. Pure data and pure functions: no state, no services.
 */

/* ---------------- bounds and vocabularies ---------------- */

/** Bounds for the config numbers; a wrong value here would break a session, not a request. */
export const STREAM_FPS_RANGE = [1, 60];
const IDLE_STOP_RANGE = [5000, 3600000];
const JPEG_QUALITY_RANGE = [1, 10];

/** `codec` config values (CONTRACT §7.3); `auto` means h264 when a decoder is available. */
const CODEC_VALUES = ['auto', 'mjpeg', 'h264'];

/* ---------------- config ---------------- */

/** Every config key this plugin reads, with the defaults the patch row also carries. */
export const CONFIG_DEFAULTS = {
  baseUrl: 'http://linkr.local',
  username: 'admin',
  password: '',
  codec: 'auto',
  ffmpegPath: '',
  jpegQuality: 4,
  manageVideoMode: true,
  streamFps: 20,
  idleStopMs: 120000,
  screenshotDir: '',
};

/** Row config keys a settings write may change. */
export const WRITABLE_KEYS = [
  'baseUrl',
  'username',
  'password',
  'codec',
  'ffmpegPath',
  'jpegQuality',
  'manageVideoMode',
  'streamFps',
  'idleStopMs',
  'screenshotDir',
];

/**
 * Normalize one raw row config. `issues` is present only when the caller wants
 * validation (the Config schema); a plain read passes nothing and gets defaults.
 */
export function normalizeConfig(raw, issues) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const text = (key, fallback) => {
    const value = config[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string') {
      issues?.push({ message: `${key} must be a string`, path: [{ key }] });
      return fallback;
    }
    return value;
  };
  const number = (key, fallback, range) => {
    const value = config[key];
    if (value === undefined || value === null) return fallback;
    const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      issues?.push({ message: `${key} must be a number`, path: [{ key }] });
      return fallback;
    }
    if (range && (parsed < range[0] || parsed > range[1])) {
      issues?.push({ message: `${key} must be between ${range[0]} and ${range[1]}`, path: [{ key }] });
      // A row written by hand still has to run: keep the nearest bound rather
      // than snapping back to the default (a 60 fps typo must not halve the feed).
      return Math.min(range[1], Math.max(range[0], parsed));
    }
    return parsed;
  };
  const flag = (key, fallback) => {
    const value = config[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') {
      issues?.push({ message: `${key} must be true or false`, path: [{ key }] });
      return fallback;
    }
    return value;
  };

  let baseUrl = text('baseUrl', CONFIG_DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  if (baseUrl === '') baseUrl = CONFIG_DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) {
    issues?.push({
      message: `baseUrl must start with http:// or https:// (the device serves plain HTTP), got "${baseUrl}"`,
      path: [{ key: 'baseUrl' }],
    });
  }
  const codec = text('codec', CONFIG_DEFAULTS.codec).trim().toLowerCase();
  if (!CODEC_VALUES.includes(codec)) {
    issues?.push({
      message: `codec must be one of ${CODEC_VALUES.join(', ')}`,
      path: [{ key: 'codec' }],
    });
  }
  return {
    baseUrl,
    username: text('username', CONFIG_DEFAULTS.username),
    password: text('password', CONFIG_DEFAULTS.password),
    codec: CODEC_VALUES.includes(codec) ? codec : CONFIG_DEFAULTS.codec,
    ffmpegPath: text('ffmpegPath', CONFIG_DEFAULTS.ffmpegPath),
    jpegQuality: number('jpegQuality', CONFIG_DEFAULTS.jpegQuality, JPEG_QUALITY_RANGE),
    manageVideoMode: flag('manageVideoMode', CONFIG_DEFAULTS.manageVideoMode),
    streamFps: number('streamFps', CONFIG_DEFAULTS.streamFps, STREAM_FPS_RANGE),
    idleStopMs: number('idleStopMs', CONFIG_DEFAULTS.idleStopMs, IDLE_STOP_RANGE),
    screenshotDir: text('screenshotDir', CONFIG_DEFAULTS.screenshotDir),
  };
}

/** Row config fields this plugin exposes; also the shape of a saved write. */
export const CONFIG_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    baseUrl: {
      type: 'string',
      default: CONFIG_DEFAULTS.baseUrl,
      title: 'Device URL',
      description: 'Origin of the Linkr device on the LAN, e.g. http://linkr.local or http://linkr.local (no trailing slash; plain HTTP on port 80)',
    },
    username: {
      type: 'string',
      default: CONFIG_DEFAULTS.username,
      title: 'Device account',
      description: 'Linkr device account name used for the login call',
    },
    password: {
      type: 'string',
      default: CONFIG_DEFAULTS.password,
      title: 'Device password',
      description: 'Device account password; empty = use the linkr/device credentials record instead (preferred: it never lands in a config file)',
    },
    codec: {
      type: 'string',
      enum: CODEC_VALUES,
      default: CONFIG_DEFAULTS.codec,
      title: 'Codec',
      description:
        'auto = H.264 over the media socket when an ffmpeg decoder is available, else MJPEG (the device\'s own JPEG frames); ' +
        'mjpeg = force the device JPEG path; h264 = force H.264 (falls back to MJPEG with a note when no decoder is found)',
    },
    ffmpegPath: {
      type: 'string',
      default: CONFIG_DEFAULTS.ffmpegPath,
      title: 'ffmpeg path',
      description: 'ffmpeg used to decode H.264 into JPEG frames; empty = $FFMPEG_PATH, /opt/homebrew/bin/ffmpeg, then ffmpeg on PATH',
    },
    jpegQuality: {
      type: 'number',
      default: CONFIG_DEFAULTS.jpegQuality,
      title: 'JPEG quality',
      description: `ffmpeg -q:v value for the H.264 path, ${JPEG_QUALITY_RANGE[0]}-${JPEG_QUALITY_RANGE[1]} (smaller = better quality; ignored on the MJPEG path)`,
    },
    manageVideoMode: {
      type: 'boolean',
      default: CONFIG_DEFAULTS.manageVideoMode,
      title: 'Manage video mode',
      description: 'true = switch the device to MJPEG (video_codec 1) while a session is live and restore the previous value afterwards; false = never write the device setting',
    },
    streamFps: {
      type: 'number',
      default: CONFIG_DEFAULTS.streamFps,
      title: 'Stream fps',
      description: `Frames per second handed to the live screen panel and kept as the latest frame (${STREAM_FPS_RANGE[0]}-${STREAM_FPS_RANGE[1]}; the device itself runs ~37 MJPEG or ~52-60 H.264 packets per second, so above ~37 only the H.264 path can keep up)`,
    },
    idleStopMs: {
      type: 'number',
      default: CONFIG_DEFAULTS.idleStopMs,
      title: 'Idle stop (ms)',
      description: 'Stop the session (and restore the video mode) after this long without a capture, an input or a panel frame request',
    },
    screenshotDir: {
      type: 'string',
      default: CONFIG_DEFAULTS.screenshotDir,
      title: 'Screenshot directory',
      description: 'Where linkr_computer_use writes capture JPEGs; empty = <working directory>/.linkr',
    },
  },
};

/**
 * Standard-Schema face of the row config: the Loader validates every write with
 * it, and the editors project `jsonSchema` for their forms.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-linkr',
    validate(value) {
      const issues = [];
      const normalized = normalizeConfig(value, issues);
      return issues.length > 0 ? { issues } : { value: normalized };
    },
    jsonSchema: { input: () => CONFIG_JSON_SCHEMA },
  },
};
