/**
 * Host-half smoke harness for dsh-linkr.
 *
 * Stands up a minimal `ctx` stub (tools.register / webServer.register / effect /
 * get / fiber), applies `index.js` to it, serves the registered `/linkr` prefix
 * route from a real `node:http` server, and drives every route and every tool
 * through those stubs. Every item prints PASS or FAIL with what it observed.
 *
 * Two modes, printed in the banner:
 *   real — `../lib/index.js` exists (the transport workstream's client). With
 *          `./fake-device.mjs` present, the plugin is also pointed at that fake
 *          device and the whole path (login, MJPEG, capture, input) is exercised.
 *   stub — `../lib/index.js` does not exist yet: a stand-in client with the same
 *          CONTRACT.md surface is staged under /tmp, and the run proves the host
 *          wiring only. The stub is never used when the real lib is present.
 *
 * Run: node test/host-smoke.mjs [--stub]
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const LIB_PATH = join(PLUGIN_ROOT, 'lib', 'index.js');
const FAKE_DEVICE_PATH = join(HERE, 'fake-device.mjs');
const STAGING = join(tmpdir(), 'dsh-linkr-host-smoke');
const WORKDIR = join(tmpdir(), 'dsh-linkr-host-smoke-work');

// `--stub` forces the fallback path even when lib/ is present, so the stub run
// stays reproducible after the transport half landed.
const forceStub = process.argv.includes('--stub');
/**
 * A one-second 320x180 baseline H.264 AnnexB clip (generated once with ffmpeg,
 * 969 bytes), served by the fake device as ws-media packets in device mode 2.
 * Embedded so the H.264 case needs no fixture file.
 */
const H264_CLIP = Buffer.from(
  'AAAAAWdCwB7ZAUGfnwEQAAADABAAAAMBQPFi5IAAAAABaMuDyyAAAAEGBf//a9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29y' +
  'ZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRw' +
  'Oi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5h' +
  'bHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5n' +
  'ZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNo' +
  'cm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz02IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRl' +
  'Y2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWln' +
  'aHRwPTAga2V5aW50PTEwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTEw' +
  'IHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89' +
  'MS40MCBhcT0xOjEuMDAAgAAAAWWIhA/xGKAAIW8cAARZo4AAisycnJycnJycnJycnJycnJycnJyddddddddddddddddddddd' +
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' +
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' +
  'dddddddeAAAAAUGaOB/gPGAAAAABQZpUB/gPGAAAAAFBmmA/wHjAAAAAAUGagD/AeMAAAAABQZqgP8B4wAAAAAFBmsA/wHjA' +
  'AAAAAUGa4D/AeMAAAAABQZsAO8B4wAAAAAFBmyA3wHjA',
  'base64',
);

const libReady = !forceStub && existsSync(LIB_PATH);
const fakeDeviceReady = existsSync(FAKE_DEVICE_PATH) && libReady;
const mode = libReady ? 'real' : 'stub';

/** Stand-in for lib/index.js: the same public surface, no device, no session. */
const STUB_LIB = `// Staged by test/host-smoke.mjs because lib/index.js does not exist yet.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\\0\\0', 'latin1'),
  Buffer.alloc(140, 0x20),
  Buffer.from([0xff, 0xd9]),
]);

export class LinkrError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LinkrError';
    this.status = options.status ?? 0;
    this.code = options.code ?? 0;
    this.path = options.path ?? '';
    this.sentence = message;
  }
}

export class LinkrClient {
  static instances = [];
  constructor(options = {}) {
    this.options = { manageVideoMode: true, fps: 10, idleStopMs: 120000, ...options };
    this.connected = false;
    this.device = null;
    this.inputs = [];
    this.captures = 0;
    this.frames = 0;
    this.seq = 0;
    this.lastFrameAt = 0;
    this.listeners = new Set();
    this.timer = null;
    this.disposed = false;
    LinkrClient.instances.push(this);
  }
  configure(options = {}) { Object.assign(this.options, options); }
  get state() {
    return {
      configured: Boolean(this.options.baseUrl && this.options.username && this.options.password),
      origin: this.options.baseUrl ?? '',
      connected: this.connected,
      device: this.device,
      videoMode: this.connected ? 1 : null,
      modeOwned: this.connected && this.options.manageVideoMode !== false,
      frames: this.frames,
      fps: this.connected ? this.options.fps : 0,
      width: this.connected ? 640 : 0,
      height: this.connected ? 480 : 0,
      lastFrameAt: this.lastFrameAt,
      codec: 'mjpeg',
      decoder: null,
      notice: '',
      error: '',
    };
  }
  async connect() {
    if (this.connected) return;
    if (!this.options.password) throw new LinkrError('the device login needs the account password (stub client: none configured)');
    // The stub is not a device: only a loopback origin is answered, so a test
    // that points the plugin at linkr.local gets the failure a real LAN would.
    let host = '';
    let port = '';
    try { host = new URL(this.options.baseUrl).hostname; port = new URL(this.options.baseUrl).port; } catch { host = ''; }
    if (host !== '127.0.0.1' && host !== 'localhost') {
      throw new LinkrError('cannot reach the Linkr device at ' + this.options.baseUrl + ' (stub client)');
    }
    // 127.0.0.1:1 is this harness's "nothing is listening" endpoint; the stub has
    // no device either, so it must refuse that one too.
    if (port === '1') {
      throw new LinkrError('cannot reach the Linkr device at ' + this.options.baseUrl + ' (stub client)');
    }
    this.connected = true;
    this.device = { deviceName: 'Fake Linkr', status: 'online', version: '1.6.0', model: 'FakeRadxa', sn: 'FAKE-0001', onlineTime: 42 };
    this.seq += 1;
    this.frames += 1;
    this.lastFrameAt = Date.now();
    this.timer = setInterval(() => this.emit(), Math.max(20, Math.round(1000 / (this.options.fps || 10))));
    this.timer.unref?.();
  }
  emit() {
    if (!this.connected) return;
    this.seq += 1;
    this.frames += 1;
    this.lastFrameAt = Date.now();
    const frame = { seq: this.seq, jpeg: JPEG, width: 640, height: 480, at: Date.now() };
    for (const listener of this.listeners) {
      try { listener(frame); } catch { /* a broken viewer must not break the session */ }
    }
  }
  async disconnect() {
    this.connected = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
  async probe() {
    return { device: this.device ?? { deviceName: 'Fake Linkr', status: 'online', version: '1.6.0' }, videoMode: this.connected ? 1 : null };
  }
  async capture({ timeoutMs = 6000 } = {}) {
    if (!this.connected) throw new LinkrError('no live session; call linkr_status first (stub client)');
    this.captures += 1;
    this.emit();
    return { jpeg: JPEG, width: 640, height: 480, at: Date.now(), seq: this.seq };
  }
  async input(action) {
    if (!this.connected) throw new LinkrError('no live session; call linkr_status first (stub client)');
    this.inputs.push(action);
    if (action.kind === 'mouse') return { applied: 'mouse', detail: action.action };
    if (action.kind === 'key') return { applied: 'key', detail: action.combo };
    if (action.kind === 'text') return { applied: 'text', detail: [...action.text].length + ' keys' };
    throw new LinkrError('unsupported input: ' + action.kind);
  }
  onFrame(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose() {
    this.disposed = true;
    this.connected = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
`;

/* ---------------- tiny test runner ---------------- */

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

/* ---------------- ctx stub ---------------- */

function makeCtx(options = {}) {
  const tools = new Map();
  const routes = [];
  const cleanups = [];
  const events = { edited: [], records: [], images: [], credentialsFail: false, editorFail: false };
  const credentials =
    options.credentials === false
      ? undefined
      : {
          async readRecord(key) {
            events.records.push({ op: 'read', key });
            return options.storedRecord === undefined ? undefined : { kind: 'grant', payload: { password: options.storedRecord } };
          },
          async modifyRecord(key, mutate) {
            if (events.credentialsFail) throw new Error('credential store unavailable');
            const next = await mutate(undefined);
            events.records.push({ op: 'write', key, value: next });
            return next;
          },
        };
  // The attachment service a computer-use capture returns its image through
  // (CONTRACT §14.1). `attachments: false` is a profile that has none.
  const attachments =
    options.attachments === false
      ? undefined
      : {
          imageLimits: {
            maxImageBytes: options.maxImageBytes ?? 8 * 1024 * 1024,
            maxImagesPerMessage: 10,
            maxMessageImageBytes: 20 * 1024 * 1024,
            maxImagePixels: 40_000_000,
            maxImageDimension: 8192,
            mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
          },
          async saveImage(input) {
            if (options.saveImageThrows === true) throw new Error('the deployment refused this image');
            const bytes = Buffer.from(input.data);
            events.images.push({ mediaType: input.mediaType, name: input.name, data: bytes });
            // ImageAttachmentRef, the verified shape (CONTRACT §14.1).
            return {
              attachmentId: `att-${events.images.length}`,
              mediaType: input.mediaType,
              bytes: bytes.length,
              width: options.imageWidth ?? 640,
              height: options.imageHeight ?? 360,
              ...(typeof input.name === 'string' ? { name: input.name } : {}),
            };
          },
        };
  const editor =
    options.editor === false
      ? undefined
      : {
          async edit(entry, change) {
            if (events.editorFail) throw new Error('profile is read-only');
            const current = { ...(options.currentConfig ?? {}) };
            const next = change(current);
            events.edited.push({ entry, next });
            return undefined;
          },
        };
  // A Session working-directory service, when the case wants one.
  const workingDirectory =
    options.workingDirectory === undefined
      ? undefined
      : {
          async ensure(agent, signal) {
            events.ensureCalls = (events.ensureCalls ?? 0) + 1;
            if (options.workingDirectoryThrows === true) throw new Error('the session directory disappeared');
            return options.workingDirectory;
          },
        };
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    effect(init) {
      const disposer = init();
      if (typeof disposer === 'function') cleanups.push(disposer);
      return disposer;
    },
    get(name) {
      if (name === 'configEditor') return editor;
      if (name === 'credentials') return credentials;
      if (name === 'workingDirectory') return workingDirectory;
      if (name === 'attachments') return attachments;
      return undefined;
    },
    fiber: options.editor === false ? {} : { entry: { id: 'linkr', name: 'dsh-linkr' } },
    // Test-only handles.
    __tools: tools,
    __routes: routes,
    __events: events,
    __dispose() {
      for (const disposer of cleanups.splice(0).reverse()) disposer();
    },
  };
  return ctx;
}

/* ---------------- a real HTTP server over the registered prefix route ---------------- */

async function serve(ctx) {
  const route = ctx.__routes.find((entry) => entry.kind === 'prefix' && entry.path === '/linkr');
  assert.ok(route, 'the plugin registered a prefix route at /linkr');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/linkr' || url.pathname.startsWith('/linkr/')) {
      Promise.resolve(route.handler(req, res)).catch(() => {
        try {
          res.writeHead(500);
          res.end();
        } catch {
          /* already answered */
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      // fetch keeps sockets alive; without this a close() would wait for them.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function httpJson(site, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(site.origin + path, { method: options.method ?? 'GET', headers, body });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function httpBytes(site, path) {
  const response = await fetch(site.origin + path);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, buffer, text: buffer.toString('utf8') };
}

/** A stream response with a growing buffer, so a test can wait for a shape. */
function readStream(site, path) {
  return new Promise((resolve, reject) => {
    const req = httpGet(new URL(site.origin + path), (res) => {
      const chunks = [];
      let ended = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        ended = true;
      });
      resolve({
        req,
        res,
        ended: () => ended,
        text: () => Buffer.concat(chunks).toString('utf8'),
        bytes: () => Buffer.concat(chunks),
      });
    });
    req.on('error', reject);
  });
}

/** Is an ffmpeg runnable on this machine? The H.264 case needs a real decoder. */
function ffmpegHere() {
  const candidates = [process.env.FFMPEG_PATH, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, 'ffmpeg');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function waitFor(predicate, timeoutMs = 5000, step = 25) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

/* ---------------- driving a tool the way the registry does ---------------- */

/**
 * Call `linkr_computer_use` and project it exactly as the registry would: the
 * execute value must be lossless JSON (it is validated against `output.schema`
 * and deep-frozen), and `render` turns it into content blocks.
 */
async function runTool(ctx, args, exec = {}) {
  const tool = ctx.__tools.get('linkr_computer_use');
  assert.ok(tool, 'linkr_computer_use is registered');
  const value = await tool.execute(args, exec);
  const json = JSON.parse(JSON.stringify(value));
  assert.deepEqual(json, value, 'the tool value must be lossless JSON (the registry validates and freezes it)');
  const content = tool.output.render(args, json);
  assert.ok(Array.isArray(content) && content.length > 0, 'render returns content blocks');
  assert.ok(
    content.every((block) => block !== null && typeof block === 'object' && typeof block.type === 'string'),
    `every block is a content block: ${JSON.stringify(content)}`,
  );
  return {
    tool,
    value: json,
    content,
    text: content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
    images: content.filter((block) => block.type === 'image'),
  };
}

/**
 * Decode one HID message the way the device reads it: `[1 byte type][protobuf]`.
 * Fields: mouse 1 type, 2 buttons, 3 absX (double), 4 absY, 7 wheelY, 8 wheelX;
 * keyboard 1 down (bool), 2 key, 3 code.
 */
function decodeHid(frame) {
  const buffer = Buffer.from(frame);
  const type = buffer[0];
  const fields = {};
  let index = 1;
  const varint = () => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = buffer[index++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return BigInt.asIntN(64, value);
  };
  while (index < buffer.length) {
    const tag = buffer[index++];
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) fields[field] = Number(varint());
    else if (wire === 1) {
      fields[field] = buffer.readDoubleLE(index);
      index += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      fields[field] = buffer.subarray(index, index + length).toString('utf8');
      index += length;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} in field ${field}`);
    }
  }
  return { type, fields, buffer };
}

/**
 * The fake device reads the socket asynchronously, so frames of the *previous*
 * action can still be in flight. Wait for the count to stop moving and use that
 * as the start of the next slice.
 */
async function hidCursor(fake) {
  let count = -1;
  for (let i = 0; i < 60; i += 1) {
    if (fake.hidFrames.length === count) return count;
    count = fake.hidFrames.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fake.hidFrames.length;
}

/** The bytes of a message field, for assertions that read best as "the frame said…". */
function near(actual, expected, tolerance = 0.002) {
  return Math.abs(Number(actual) - expected) <= tolerance;
}

/* ---------------- main ---------------- */

async function main() {
  await rm(STAGING, { recursive: true, force: true });
  await rm(WORKDIR, { recursive: true, force: true });
  await mkdir(WORKDIR, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(WORKDIR);
  // macOS resolves /var -> /private/var, so compare against the cwd Node reports.
  const workdir = process.cwd();

  let entryPath = join(PLUGIN_ROOT, 'index.js');
  if (!libReady) {
    await mkdir(join(STAGING, 'lib'), { recursive: true });
    await writeFile(join(STAGING, 'lib', 'index.js'), STUB_LIB, 'utf8');
    await cp(join(PLUGIN_ROOT, 'index.js'), join(STAGING, 'index.js'));
    // index.js is wiring only: the split host/ modules must travel with it.
    await cp(join(PLUGIN_ROOT, 'host'), join(STAGING, 'host'), { recursive: true });
    entryPath = join(STAGING, 'index.js');
  }

  // The real path needs a device: test/fake-device.mjs speaks the Linkr protocol
  // (HTTP + a real WebSocket upgrade), so the plugin's own lib/ client runs
  // unchanged against it. Without it the plugin still runs, but nothing answers.
  let fake = null;
  let fakeCanned = null;
  // Without a fake device (stub run) any loopback origin will do: the stand-in
  // client answers it. 127.0.0.1:1 stays reserved for the unreachable-endpoint tests.
  let deviceOrigin = 'http://127.0.0.1:4789';
  const deviceUser = { username: 'tester', password: 's3cret' };
  if (fakeDeviceReady) {
    const module = await import(pathToFileURL(FAKE_DEVICE_PATH).href);
    fake = module.createFakeDevice({
      username: deviceUser.username,
      password: deviceUser.password,
      initialCodec: 0,
      h264Clip: H264_CLIP,
      h264PacketIntervalMs: 19,
    });
    fakeCanned = module.CANNED_JPEG;
    deviceOrigin = await fake.listen();
  }

  console.log('dsh-linkr host smoke');
  console.log(`  mode        : ${mode}${libReady ? '' : ' (STUB LinkrClient — lib/index.js is missing)'}`);
  console.log(`  entry       : ${entryPath}`);
  console.log(`  fake device : ${fake === null ? 'not present' : deviceOrigin}`);
  console.log(`  workdir     : ${workdir}`);
  console.log('');

  const plugin = await import(pathToFileURL(entryPath).href);
  const { apply, Config } = plugin;

  let ctx = null;
  let site = null;
  let credentialsStub = null;

  try {
    await check('exports: name/inject/Config/apply', () => {
      assert.equal(plugin.name, 'linkr', 'name must be the patch row id');
      assert.deepEqual(plugin.inject, ['tools', 'webServer']);
      assert.ok(Config && Config['~standard'] && Config['~standard'].version === 1, 'Config standard-schema face');
      assert.equal(Config['~standard'].vendor, 'dsh-linkr');
      assert.equal(typeof apply, 'function');
      return 'name=linkr, inject=tools+webServer, Config vendor=dsh-linkr';
    });

    await check('Config.validate: defaults pass, bad baseUrl fails', () => {
      const ok = Config['~standard'].validate({});
      assert.equal(ok.issues, undefined, 'defaults must validate');
      assert.equal(ok.value.baseUrl, 'http://linkr.local');
      assert.equal(ok.value.username, 'admin');
      assert.equal(ok.value.codec, 'auto', 'codec defaults to auto');
      assert.equal(ok.value.ffmpegPath, '');
      assert.equal(ok.value.jpegQuality, 4);
      assert.equal(ok.value.manageVideoMode, true);
      assert.equal(ok.value.streamFps, 20, 'streamFps defaults to 20');
      assert.equal(ok.value.idleStopMs, 120000);
      assert.equal(ok.value.screenshotDir, '');
      const fast = Config['~standard'].validate({ baseUrl: 'http://127.0.0.1:1', username: 'u', streamFps: 60 });
      assert.equal(fast.issues, undefined, 'streamFps 60 must be accepted');
      const bad = Config['~standard'].validate({ baseUrl: 'ftp://nope', streamFps: 400 });
      assert.ok(Array.isArray(bad.issues) && bad.issues.length === 2, `expected 2 issues, got ${JSON.stringify(bad.issues)}`);
      const badCodec = Config['~standard'].validate({ codec: 'h265' });
      assert.ok(Array.isArray(badCodec.issues) && /codec must be one of auto, mjpeg, h264/.test(badCodec.issues[0].message));
      const badQuality = Config['~standard'].validate({ jpegQuality: 0 });
      assert.ok(Array.isArray(badQuality.issues), 'jpegQuality is bounded 1..10');
      const schema = Config['~standard'].jsonSchema.input();
      for (const key of ['codec', 'ffmpegPath', 'jpegQuality', 'streamFps']) {
        assert.ok(schema.properties[key], `${key} is in the config schema`);
        assert.equal(typeof schema.properties[key].description, 'string');
      }
      assert.deepEqual(schema.properties.codec.enum, ['auto', 'mjpeg', 'h264']);
      assert.equal(schema.properties.streamFps.default, 20);
      assert.equal(schema.properties.jpegQuality.default, 4);
      return 'defaults codec=auto/ffmpegPath=""/jpegQuality=4/streamFps=20; ftp://, streamFps 400, codec h265 and jpegQuality 0 rejected';
    });

    ctx = makeCtx({ storedRecord: deviceUser.password });
    credentialsStub = ctx;
    apply(ctx, {
      baseUrl: deviceOrigin,
      username: deviceUser.username,
      password: '',
      // Pinned: these cases are about routes, tools and lifecycle. The codec
      // cases below choose their own source explicitly.
      codec: 'mjpeg',
      manageVideoMode: true,
      streamFps: 10,
      idleStopMs: 120000,
      screenshotDir: '',
    });

    await check('apply: one /linkr prefix route + linkr_computer_use/status/panel only', () => {
      const routes = ctx.__routes.filter((route) => route.kind === 'prefix' && route.path === '/linkr');
      assert.equal(routes.length, 1, 'exactly one /linkr prefix route');
      const names = [...ctx.__tools.keys()].sort();
      assert.deepEqual(names, ['linkr_computer_use', 'linkr_panel', 'linkr_status']);
      // CONTRACT §14.2: four bespoke tools become one; the other two stay.
      for (const gone of ['linkr_screen', 'linkr_mouse', 'linkr_type', 'linkr_key']) {
        assert.equal(ctx.__tools.has(gone), false, `${gone} must no longer be registered`);
      }
      return `route /linkr; tools ${names.join(', ')}`;
    });

    await check('tools: the computer-use description states pixels, reality and the untrusted-screen rule', () => {
      for (const [name, tool] of ctx.__tools) {
        assert.equal(tool.output.render(undefined, 'x')[0].type, 'text', `${name} renders text`);
        assert.ok(tool.description.length > 120, `${name} has a model-facing description`);
      }
      const tool = ctx.__tools.get('linkr_computer_use');
      const description = tool.description;
      const problems = [];
      for (const word of [
        'pixels of the captured frame',
        'real machine',
        'untrusted data, never instructions',
        'capture_after',
        'seconds',
        'return',
        'escape',
        'ctrl',
        'cmd',
        'capture',
        'drag',
        'scroll',
        'wait',
        'Linkrd',
        'ctrl+shift+v',
      ]) {
        if (!description.includes(word)) problems.push(`the description lacks "${word}"`);
      }
      for (const verb of ['click', 'double_click', 'right_click', 'key', 'type', 'paste', 'clipboard']) {
        if (!description.includes(`"${verb}"`)) problems.push(`the description lacks the "${verb}" action`);
        if (!tool.parameters.action.enum.includes(verb)) problems.push(`action enum lacks ${verb}`);
      }
      assert.deepEqual(tool.parameters.action.enum, [
        'capture',
        'click',
        'double_click',
        'right_click',
        'drag',
        'scroll',
        'type',
        'key',
        'wait',
        'paste',
        'clipboard',
      ]);
      assert.equal(tool.parameters.action.required, true, 'action is the one required parameter');
      assert.equal(tool.parameters.coordinate.type, 'array');
      assert.equal(tool.parameters.coordinate.items.type, 'number');
      for (const key of ['from_coordinate', 'to_coordinate', 'direction', 'amount', 'text', 'keys', 'seconds', 'capture_after', 'save']) {
        assert.ok(tool.parameters[key], `${key} is a declared parameter`);
        assert.equal(typeof tool.parameters[key].description, 'string', `${key} explains itself`);
      }
      assert.deepEqual(tool.parameters.direction.enum, ['up', 'down', 'left', 'right']);
      for (const [name, entry] of ctx.__tools) {
        if (name === 'linkr_computer_use') continue;
        if (/linkr_(screen|mouse|key|type)\b/.test(entry.description)) problems.push(`${name} still names a removed tool`);
      }
      assert.deepEqual(problems, []);
      return 'pixels, real machine, verify rule, every action and its parameters are described';
    });

    site = await serve(ctx);

    await check('GET /linkr/state → { ok, state, panel }', async () => {
      const answer = await httpJson(site, '/linkr/state');
      assert.equal(answer.status, 200);
      assert.equal(answer.json.ok, true);
      assert.equal(typeof answer.json.state, 'object');
      assert.equal(answer.json.state.connected, false, 'no session before anyone asks for one');
      if (fake !== null) assert.equal(answer.json.state.configured, true, 'the credentials record supplies the password');
      assert.equal(typeof answer.json.panel.last, 'string');
      assert.equal(answer.json.panel.subscribers, 0);
      return `state.configured=${answer.json.state.configured}, connected=${answer.json.state.connected}`;
    });

    await check('GET /linkr/config → password masked, never echoed', async () => {
      const answer = await httpJson(site, '/linkr/config');
      assert.equal(answer.status, 200);
      assert.equal(answer.json.ok, true);
      assert.equal(answer.json.config.password, '\u2022\u2022\u2022\u2022\u2022\u2022');
      assert.ok(!answer.text.includes(deviceUser.password), 'the stored password must never leave the process');
      assert.equal(answer.json.editable, true);
      assert.equal(answer.json.config.baseUrl, deviceOrigin);
      assert.ok(answer.json.state, 'config answers with state too');
      return `password=${answer.json.config.password}, editable=${answer.json.editable}`;
    });

    await check('cross-origin guard → 403', async () => {
      const answer = await httpJson(site, '/linkr/state', { headers: { origin: 'http://evil.example' } });
      assert.equal(answer.status, 403);
      assert.equal(answer.json.ok, false);
      const same = await httpJson(site, '/linkr/state', { headers: { origin: site.origin } });
      assert.equal(same.status, 200, 'a same-origin page is allowed');
      return 'foreign Origin rejected, same Origin allowed';
    });

    await check('POST /linkr/connect → session live', async () => {
      const answer = await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.equal(answer.json.state.connected, true);
      // CONTRACT §7.3: the state names the codec the session runs and its decoder.
      const codecName = answer.json.state.codec;
      assert.ok(codecName === 'mjpeg' || codecName === 'h264', `state.codec must be mjpeg or h264, got ${JSON.stringify(codecName)}`);
      if (codecName === 'mjpeg') assert.equal(answer.json.state.decoder, null, 'MJPEG needs no decoder');
      if (codecName === 'h264') assert.equal(answer.json.state.decoder, 'ffmpeg', 'H.264 is decoded by ffmpeg');
      if (fake !== null) {
        assert.equal(fake.logins, 1, 'one device login');
        assert.deepEqual(fake.codecWrites.map((entry) => entry.video_codec), [1], 'the device was switched to MJPEG (codec 1)');
      }
      return `connected=${answer.json.state.connected}, frames=${answer.json.state.frames}`;
    });

    await check('POST /linkr/input mouse → applied, same client as the tools', async () => {
      const answer = await httpJson(site, '/linkr/input', {
        method: 'POST',
        body: { kind: 'mouse', action: 'click', x: 0.5, y: 0.25 },
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.equal(answer.json.applied, 'mouse');
      if (fake !== null) {
        const frames = await fake.waitForHid(1);
        assert.equal(frames[0][0], 2, 'message type 2 = mouse');
      }
      return `applied=${answer.json.applied}, detail=${JSON.stringify(answer.json.detail)}`;
    });

    await check('POST /linkr/input key " " → the Space key, not an empty combo', async () => {
      const before = fake !== null ? fake.hidFrames.length : 0;
      const answer = await httpJson(site, '/linkr/input', {
        method: 'POST',
        body: { kind: 'key', combo: ' ' },
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.equal(answer.json.applied, 'key');
      if (fake !== null) {
        const frames = await fake.waitForHid(before + 2);
        const added = frames.slice(before);
        assert.equal(added.length, 2, 'Space is one down and one up');
        for (const frame of added) {
          assert.equal(frame[0], 1, 'message type 1 = keyboard');
          assert.ok(Buffer.from(frame).includes(Buffer.from('Space')), 'the frame names the DOM code Space');
        }
      }
      return `applied=${answer.json.applied}, detail=${JSON.stringify(answer.json.detail)}`;
    });

    await check('GET /linkr/clipboard → the capability answer the panel renders', async () => {
      const answer = await httpJson(site, '/linkr/clipboard');
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.equal(typeof answer.json.clipboard.available, 'boolean');
      // The probe answers "is it usable", never "what is on it".
      assert.equal(answer.json.clipboard.text, '', 'the panel probe never carries clipboard text');
      if (fake !== null) {
        // The fake device has no control socket: the answer is "unavailable" with
        // a reason, never an exception and never a stalled pane.
        assert.equal(answer.json.clipboard.available, false);
        assert.match(answer.json.clipboard.reason, /^(device-error|unsupported)$/);
      }
      return `available=${answer.json.clipboard.available}, reason=${answer.json.clipboard.reason || '(none)'}`;
    });

    await check('POST /linkr/clipboard → 400 without text, 409 without Linkrd', async () => {
      const empty = await httpJson(site, '/linkr/clipboard', { method: 'POST', body: { text: '' } });
      assert.equal(empty.status, 400, empty.text);
      assert.equal(empty.json.ok, false);
      // A real device is never written to by a smoke run: the refusal path is
      // proven against the fake only.
      if (fake !== null) {
        const refused = await httpJson(site, '/linkr/clipboard', {
          method: 'POST',
          body: { text: '你好', keys: 'ctrl+v' },
        });
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.ok, false);
        assert.match(refused.json.error, /clipboard|Linkrd|control socket/i);
        assert.ok(refused.json.reason.length > 0, 'a machine reason travels with the sentence');
      }
      return 'empty text 400, no-Linkrd 409 with reason';
    });

    await check('GET /linkr/frame.jpg → a JPEG', async () => {
      const answer = await httpBytes(site, '/linkr/frame.jpg');
      assert.equal(answer.status, 200, answer.text);
      assert.match(answer.headers.get('content-type') ?? '', /^image\/jpeg/);
      assert.equal(answer.buffer[0], 0xff);
      assert.equal(answer.buffer[1], 0xd8);
      if (fakeCanned !== null) assert.equal(answer.buffer.length, fakeCanned.length, 'the device frame, byte for byte');
      return `${answer.buffer.length} bytes, ${answer.headers.get('content-type')}`;
    });

    await check('GET /linkr/live.mjpeg → multipart parts at streamFps', async () => {
      const stream = await readStream(site, '/linkr/live.mjpeg');
      assert.match(stream.res.headers['content-type'] ?? '', /^multipart\/x-mixed-replace; boundary=/);
      assert.ok(await waitFor(() => (stream.text().match(/--linkrframe/g) ?? []).length >= 2), 'at least two parts arrive');
      const text = stream.text();
      assert.ok(text.includes('Content-Type: image/jpeg'), 'each part is a JPEG');
      assert.ok(/Content-Length: \d+/.test(text), 'each part carries its length');
      if (fakeCanned !== null) assert.ok(text.includes(`Content-Length: ${fakeCanned.length}`), 'each part is the device frame');
      stream.req.destroy();
      return `${(text.match(/--linkrframe/g) ?? []).length} parts in the window`;
    });

    await check('GET /linkr/panel/stream → SSE with backlog, POST /linkr/panel publishes', async () => {
      const stream = await readStream(site, '/linkr/panel/stream');
      assert.match(stream.res.headers['content-type'] ?? '', /^text\/event-stream/);
      await waitFor(() => stream.text().includes(': linkr panel stream'));
      const posted = await httpJson(site, '/linkr/panel', { method: 'POST', body: { action: 'open' } });
      assert.equal(posted.status, 200, posted.text);
      assert.equal(posted.json.ok, true);
      assert.equal(posted.json.event.action, 'open');
      assert.ok(await waitFor(() => stream.text().includes('"action":"open"')), 'the subscriber receives the event');
      stream.req.destroy();
      const late = await readStream(site, '/linkr/panel/stream');
      assert.ok(await waitFor(() => late.text().includes('"action":"open"')), 'a late panel replays the backlog');
      late.req.destroy();
      const bad = await httpJson(site, '/linkr/panel', { method: 'POST', body: { action: 'explode' } });
      assert.equal(bad.status, 400);
      return 'event published, live reader and late reader both saw it, bad action rejected';
    });

    await check('one LinkrClient for tools and routes', async () => {
      // The tool and the route must share one client: a second instance would be a
      // second session (and, for input, a second path to the device).
      const statusText = await ctx.__tools.get('linkr_status').execute({});
      assert.match(statusText, /Linkr device/);
      await httpJson(site, '/linkr/state');
      if (mode === 'stub') {
        const instances = (await import(pathToFileURL(join(STAGING, 'lib', 'index.js')).href)).LinkrClient.instances;
        assert.equal(instances.length, 1, `expected one client, saw ${instances.length}`);
        return '1 client instance after tool + route calls';
      }
      return 'shared client (instance count not observable with the real lib)';
    });

    await check('tool linkr_status → device, session, panel, no mode switch', async () => {
      const text = await ctx.__tools.get('linkr_status').execute({});
      assert.ok(text.includes(`Linkr device at ${deviceOrigin}`), `origin line: ${text.split('\n')[0]}`);
      assert.match(text, /Fake Linkr/);
      assert.match(text, /^codec: /m, 'the status names the codec');
      assert.match(text, /^device mode: /m, 'the status names the device mode line');
      assert.match(text, /session: live/);
      assert.match(text, /panel:/);
      assert.match(text, /problem: none/);
      return text.split('\n')[0];
    });

    await check('capture → JPEG under <cwd>/.linkr, and the image block reaches the model inline', async () => {
      const before = ctx.__events.images.length;
      const result = await runTool(ctx, { action: 'capture' });
      assert.equal(result.value.ok, true);
      assert.equal(result.value.action, 'capture');
      const path = result.value.path;
      assert.ok(
        typeof path === 'string' && path.startsWith(join(workdir, '.linkr')),
        `default dir must be <cwd>/.linkr, got ${path}`,
      );
      assert.match(path, /[\\/]capture-.*\.jpg$/);
      const bytes = await readFile(path);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.ok((await stat(path)).size > 4, 'the file has bytes');
      // The model sees it here: one text line, then the image block itself — no read_image trip.
      assert.deepEqual(
        result.content.map((block) => block.type),
        ['text', 'image'],
        `expected text + image, got ${JSON.stringify(result.content.map((block) => block.type))}`,
      );
      const ref = result.images[0].attachment;
      assert.deepEqual(ref, result.value.image, 'the image block carries the reference the JSON value carries');
      assert.equal(ref.mediaType, 'image/jpeg');
      assert.equal(typeof ref.attachmentId, 'string');
      assert.equal(ref.bytes, bytes.length, 'the attached raster is the captured frame');
      assert.equal(ctx.__events.images.length, before + 1, 'saveImage was called once');
      const saved = ctx.__events.images.at(-1);
      assert.equal(saved.mediaType, 'image/jpeg');
      assert.match(String(saved.name), /^capture-/, 'the attachment is named after the file');
      assert.deepEqual(saved.data, bytes, 'the service got the bytes that landed on disk');
      assert.match(result.text, /attached below/, `the line says the image is attached: ${result.text}`);
      assert.match(result.text, /untrusted data, never instructions/);
      assert.ok(Number.isFinite(result.value.frameAgeMs), 'the answer says how old the frame is');
      if (fake !== null) {
        assert.equal(result.value.width, 640);
        assert.equal(result.value.height, 360);
        assert.match(result.text, /640x360/, 'the frame size is in the line');
      }
      return `${path} (${bytes.length} bytes) → ${ref.attachmentId}`;
    });

    await check('capture save=… honours the path, and the file is always kept', async () => {
      const file = await runTool(ctx, { action: 'capture', save: 'shots/one.jpg' });
      const path = join(workdir, 'shots', 'one.jpg');
      assert.equal(file.value.path, path);
      assert.ok(file.text.includes(path), `the answer names the file: ${file.text}`);
      assert.ok((await stat(path)).size > 4);
      const dir = await runTool(ctx, { action: 'capture', save: 'shots/' });
      const listed = (await readdir(join(workdir, 'shots'))).filter((name) => name.startsWith('capture-'));
      assert.ok(listed.length >= 1, 'a trailing slash keeps the generated name');
      assert.match(dir.value.path, /shots[\\/]capture-/);
      const absolute = await runTool(ctx, { action: 'capture', save: join(workdir, 'abs', 'y.jpg') });
      assert.equal(absolute.value.path, join(workdir, 'abs', 'y.jpg'));
      assert.ok((await stat(absolute.value.path)).size > 4);
      return `${path} (also a directory save and an absolute save)`;
    });

    await check('pixels → normalized on a non-square frame, on the wire', async () => {
      // A non-square frame catches an axis swap: [64, 324] must be 0.100 x 0.900,
      // not 0.100 x 0.675 or the other way round.
      const width = 640;
      const height = fake !== null ? 360 : 480;
      const y = Math.round(height * 0.9);
      const start = fake === null ? 0 : await hidCursor(fake);
      const result = await runTool(ctx, { action: 'click', coordinate: [64, y] });
      assert.equal(result.value.ok, true);
      assert.equal(result.value.width, width);
      assert.equal(result.value.height, height);
      assert.match(result.text, new RegExp(`64, ${y} of the ${width}x${height} frame`));
      if (fake !== null) {
        await fake.waitForHid(start + 3, 3000);
        const mouse = fake.hidFrames
          .slice(start)
          .map(decodeHid)
          .filter((message) => message.type === 2);
        assert.ok(mouse.length >= 3, `expected move/down/up, got ${mouse.length}`);
        assert.deepEqual(mouse.slice(0, 3).map((message) => message.fields[1]), [1, 2, 4], 'move, down, up');
        for (const message of mouse.slice(0, 3)) {
          assert.ok(near(message.fields[3], 64 / width), `absX ${message.fields[3]} should be ${64 / width}`);
          assert.ok(near(message.fields[4], 0.9), `absY ${message.fields[4]} should be 0.900`);
        }
        assert.deepEqual(
          mouse.slice(0, 3).map((message) => message.fields[2]),
          [0, 1, 0],
          'buttons: none on the move, left while pressed, released after',
        );
      }
      // The centre and the far corner are inside the frame, and map to exactly 0.5/1.
      const centre = await runTool(ctx, { action: 'click', coordinate: [width / 2, height / 2] });
      assert.match(centre.text, new RegExp(`${width / 2}, ${height / 2} of the ${width}x${height} frame`));
      const corner = await runTool(ctx, { action: 'click', coordinate: [width, height] });
      assert.equal(corner.value.ok, true, 'the bottom-right pixel is still inside the frame');
      return `[64, ${y}] of ${width}x${height} → absX ${(64 / width).toFixed(4)}, absY 0.9000`;
    });

    await check('a coordinate outside the frame is refused, naming the frame size', async () => {
      const width = 640;
      const height = fake !== null ? 360 : 480;
      await assert.rejects(
        () => runTool(ctx, { action: 'click', coordinate: [width + 10, 10] }),
        new RegExp(`outside the captured frame: it is ${width}x${height}`),
      );
      await assert.rejects(
        () => runTool(ctx, { action: 'click', coordinate: [10, height + 10] }),
        new RegExp(`outside the captured frame: it is ${width}x${height}`),
      );
      await assert.rejects(() => runTool(ctx, { action: 'click', coordinate: [-1, 10] }), /outside the captured frame/);
      await assert.rejects(() => runTool(ctx, { action: 'click' }), /coordinate must be \[x, y\] in pixels/);
      await assert.rejects(() => runTool(ctx, { action: 'click', coordinate: [1] }), /coordinate must be \[x, y\] in pixels/);
      await assert.rejects(() => runTool(ctx, { action: 'click', coordinate: ['a', 'b'] }), /coordinate must be \[x, y\]/);
      await assert.rejects(() => runTool(ctx, { action: 'drag', coordinate: [1, 1] }), /to_coordinate must be \[x, y\] in pixels/);
      await assert.rejects(
        () => runTool(ctx, { action: 'drag', from_coordinate: [0, 0], to_coordinate: [width + 1, 1] }),
        /outside the captured frame/,
      );
      await assert.rejects(
        () => runTool(ctx, { action: 'scroll', direction: 'down', coordinate: [0, height + 5] }),
        /outside the captured frame/,
      );
      return `x>${width}, y>${height}, negative and malformed coordinates all refused with the ${width}x${height} frame named`;
    });

    await check('each action sends the right HID frames', async () => {
      if (fake === null) return 'skipped: the stand-in client has no media socket to read HID frames from';
      const take = async (count, run) => {
        const start = await hidCursor(fake);
        await run();
        await fake.waitForHid(start + count, 3000);
        return fake.hidFrames.slice(start).map(decodeHid);
      };
      const mouseOf = (messages) => messages.filter((message) => message.type === 2);
      const keysOf = (messages) => messages.filter((message) => message.type === 1);

      const click = mouseOf(await take(3, () => runTool(ctx, { action: 'click', coordinate: [320, 180] })));
      assert.deepEqual(click.map((message) => message.fields[1]), [1, 2, 4], 'click = move, down, up');
      assert.deepEqual(click.map((message) => message.fields[2]), [0, 1, 0], 'click uses the left button');

      const double = mouseOf(await take(5, () => runTool(ctx, { action: 'double_click', coordinate: [320, 180] })));
      assert.deepEqual(double.map((message) => message.fields[1]), [1, 2, 4, 2, 4], 'double_click = move + two pairs');
      assert.deepEqual(double.map((message) => message.fields[2]), [0, 1, 0, 1, 0]);

      const right = mouseOf(await take(3, () => runTool(ctx, { action: 'right_click', coordinate: [100, 60] })));
      assert.deepEqual(right.map((message) => message.fields[2]), [0, 2, 0], 'right_click presses button mask 2');

      const drag = mouseOf(
        await take(7, () => runTool(ctx, { action: 'drag', from_coordinate: [64, 36], to_coordinate: [512, 288] })),
      );
      assert.equal(drag[0].fields[1], 1, 'drag starts by moving to the start point');
      assert.equal(drag[1].fields[1], 2, 'then presses');
      assert.equal(drag[1].fields[2], 1, 'holding the left button');
      assert.ok(near(drag[1].fields[3], 0.1) && near(drag[1].fields[4], 0.1), 'pressed at the start point');
      const release = drag.at(-1);
      assert.equal(release.fields[1], 4, 'and releases');
      assert.equal(release.fields[2], 0, 'with no button held');
      assert.ok(near(release.fields[3], 0.8) && near(release.fields[4], 0.8), 'released at the end point');

      const down = mouseOf(await take(1, () => runTool(ctx, { action: 'scroll', direction: 'down' })));
      assert.equal(down.length, 1);
      assert.equal(down[0].fields[1], 3, 'scroll is a wheel message');
      assert.equal(down[0].fields[7], 3, 'three ticks down is +3 (the device web UI sends sign(deltaY))');
      assert.equal(down[0].fields[8] ?? 0, 0, 'no horizontal delta');
      const up = mouseOf(
        await take(1, () => runTool(ctx, { action: 'scroll', direction: 'up', amount: 5, coordinate: [320, 180] })),
      );
      assert.equal(up[0].fields[7], -5, 'up is the negative vertical delta');
      assert.ok(near(up[0].fields[3], 0.5) && near(up[0].fields[4], 0.5), 'the wheel turns where it was asked');
      const sideways = mouseOf(await take(1, () => runTool(ctx, { action: 'scroll', direction: 'right', amount: 2 })));
      assert.equal(sideways[0].fields[8], 2, 'right is a positive horizontal delta');
      assert.equal(sideways[0].fields[7] ?? 0, 0);

      const typed = await take(10, () => runTool(ctx, { action: 'type', text: 'Hi!' }));
      const textKeys = keysOf(typed);
      assert.deepEqual(
        textKeys.map((message) => message.fields[3]),
        ['ShiftLeft', 'KeyH', 'KeyH', 'ShiftLeft', 'KeyI', 'KeyI', 'ShiftLeft', 'Digit1', 'Digit1', 'ShiftLeft'],
        'US layout: shifted characters hold Shift around their key',
      );
      assert.deepEqual(
        textKeys.map((message) => message.fields[1]),
        [1, 1, 0, 0, 1, 0, 1, 1, 0, 0],
        'every key has a down and an up',
      );

      const chord = keysOf(await take(6, () => runTool(ctx, { action: 'key', keys: 'ctrl+alt+t' })));
      assert.deepEqual(
        chord.map((message) => message.fields[3]),
        ['ControlLeft', 'AltLeft', 'KeyT', 'KeyT', 'AltLeft', 'ControlLeft'],
        'modifiers held, then released in reverse order',
      );
      const alias = keysOf(await take(2, () => runTool(ctx, { action: 'key', keys: 'return' })));
      assert.deepEqual(alias.map((message) => message.fields[3]), ['Enter', 'Enter'], '"return" is the Enter key');
      return 'click, double_click, right_click, drag, scroll (down/up/right), type and key match the device protocol';
    });

    await check('capture_after returns a second image; capture itself stays one', async () => {
      const before = ctx.__events.images.length;
      const result = await runTool(ctx, { action: 'click', coordinate: [320, 180], capture_after: true });
      assert.equal(result.value.ok, true);
      assert.equal(result.value.action, 'click');
      assert.match(result.text, /Left click at 320, 180/);
      assert.deepEqual(result.content.map((block) => block.type), ['text', 'image']);
      assert.equal(ctx.__events.images.length, before + 1, 'exactly one more saveImage');
      const path = result.value.path;
      assert.match(String(path), /[\\/]capture-.*\.jpg$/);
      const bytes = await readFile(path);
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.deepEqual(ctx.__events.images.at(-1).data, bytes, 'the follow-up capture is what was attached');
      assert.match(result.text, /Follow-up capture/);
      // A capture already returns an image: capture_after must not double it.
      const twice = await runTool(ctx, { action: 'capture', capture_after: true });
      assert.equal(twice.images.length, 1, 'one image, not two');
      return `${path}; the click's follow-up capture is attached too`;
    });

    await check('action, text, keys, seconds and scroll are validated before the device', async () => {
      await assert.rejects(() => runTool(ctx, { action: 'teleport' }), /action must be one of capture, click/);
      await assert.rejects(() => runTool(ctx, {}), /action must be one of capture, click/);
      await assert.rejects(() => runTool(ctx, { action: 'type' }), /text is required for action "type"/);
      await assert.rejects(() => runTool(ctx, { action: 'type', text: '' }), /nothing to type/);
      // ASCII only, and the refusal names the character instead of dropping it.
      // (Both are the transport client’s own sentences, so the stand-in client,
      // which implements no US layout, cannot be asked for them.)
      if (mode === 'real') {
        await assert.rejects(() => runTool(ctx, { action: 'type', text: '你好' }), /cannot type "你".*US-ASCII/);
        await assert.rejects(() => runTool(ctx, { action: 'key', keys: 'ctrl+nonsense' }), /unknown key "nonsense"/);
      }
      await assert.rejects(() => runTool(ctx, { action: 'key' }), /keys is required for action "key"/);
      await assert.rejects(() => runTool(ctx, { action: 'key', keys: '   ' }), /keys is required/);
      await assert.rejects(() => runTool(ctx, { action: 'wait', seconds: 31 }), /seconds must be a number from 0 to 30/);
      await assert.rejects(() => runTool(ctx, { action: 'wait', seconds: -1 }), /seconds must be a number from 0 to 30/);
      await assert.rejects(() => runTool(ctx, { action: 'scroll' }), /needs direction/);
      await assert.rejects(() => runTool(ctx, { action: 'scroll', direction: 'sideways' }), /needs direction/);
      await assert.rejects(() => runTool(ctx, { action: 'scroll', direction: 'up', amount: 0 }), /non-zero number of wheel ticks/);
      // Every alias CONTRACT §14.2 names resolves on the device.
      for (const alias of ['return', 'enter', 'escape', 'esc', 'tab', 'space', 'backspace', 'up', 'down', 'left', 'right', 'cmd', 'ctrl']) {
        const result = await runTool(ctx, { action: 'key', keys: alias });
        assert.equal(result.value.ok, true, `${alias} is a key the tool accepts`);
      }
      const waited = await runTool(ctx, { action: 'wait', seconds: 0.05 });
      assert.equal(waited.value.ok, true);
      assert.match(waited.text, /Waited 0\.05 s/);
      assert.equal(waited.images.length, 0, 'a wait carries no capture');
      assert.equal(waited.value.path, undefined, 'a wait writes no file');
      return 'bad action/text/keys/seconds/scroll refused; 13 key aliases accepted; wait is quiet';
    });


    await check('tool action "paste" and "clipboard" need Linkrd, and say so in one sentence', async () => {
      if (fake === null) return 'skipped on a real device: a smoke run must not write its clipboard';
      await assert.rejects(() => runTool(ctx, { action: 'paste' }), /text is required for action "paste"/);
      await assert.rejects(
        () => runTool(ctx, { action: 'paste', text: '你好', keys: 'ctrl+v' }),
        /clipboard|Linkrd|control socket/i,
      );
      await assert.rejects(() => runTool(ctx, { action: 'clipboard' }), /clipboard|Linkrd|control socket/i);
      // The failures reached the activity ring in their own buckets, so the panel
      // can phrase them instead of echoing an English sentence.
      const log = (await httpJson(site, '/linkr/log')).json.entries;
      const pasteRows = log.filter((entry) => entry.action === 'linkr_paste');
      assert.ok(pasteRows.length >= 1, 'a failed paste is recorded');
      assert.equal(pasteRows.at(-1).ok, false);
      return 'refused with a sentence; linkr_paste rows logged';
    });

    await check('tool linkr_panel → open/focus/close publish events', async () => {
      const panel = ctx.__tools.get('linkr_panel');
      for (const action of ['open', 'focus', 'close']) {
        const text = await panel.execute({ action });
        assert.match(text, new RegExp(`panel ${action} published`));
      }
      await assert.rejects(() => panel.execute({ action: 'hide' }), /action must be one of/);
      return 'open/focus/close published, unknown action rejected';
    });

    await check('POST /linkr/config → persists through configEditor, rewrites the client', async () => {
      const before = ctx.__events.edited.length;
      const answer = await httpJson(site, '/linkr/config', {
        method: 'POST',
        body: { baseUrl: 'http://127.0.0.1:1/', username: 'xzl2', password: '\u2022\u2022\u2022\u2022\u2022\u2022', streamFps: 5 },
      });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.equal(answer.json.applied, 'profile');
      assert.equal(answer.json.config.baseUrl, 'http://127.0.0.1:1', 'trailing slash stripped');
      assert.equal(answer.json.config.username, 'xzl2');
      assert.equal(answer.json.config.password, '\u2022\u2022\u2022\u2022\u2022\u2022');
      assert.ok(!answer.text.includes(deviceUser.password));
      assert.equal(ctx.__events.edited.length, before + 1, 'one configEditor edit');
      const written = ctx.__events.edited.at(-1).next;
      assert.equal(written.baseUrl, 'http://127.0.0.1:1');
      assert.equal(written.username, 'xzl2');
      assert.equal(written.streamFps, 5);
      assert.ok(!('password' in written), 'a masked password is never written anywhere');
      for (const badUrl of ['nope', 'http://127.0.0.1:1/linkr', 'http://127.0.0.1:1/?x=1', 'ftp://127.0.0.1:1']) {
        const bad = await httpJson(site, '/linkr/config', { method: 'POST', body: { baseUrl: badUrl } });
        assert.equal(bad.status, 400, `baseUrl ${badUrl} must be rejected`);
      }
      const empty = await httpJson(site, '/linkr/config', { method: 'POST', body: { password: '\u2022\u2022\u2022\u2022\u2022\u2022' } });
      assert.equal(empty.status, 400, 'a masked password alone is not a change');
      return `applied=profile, configEditor edit carried baseUrl/username/streamFps, no password key`;
    });

    await check('a failed password store rolls the saved row back', async () => {
      const before = await httpJson(site, '/linkr/config');
      assert.equal(before.status, 200, before.text);
      const beforeUser = before.json.config.username;
      const edits = ctx.__events.edited.length;
      ctx.__events.credentialsFail = true;
      const answer = await httpJson(site, '/linkr/config', {
        method: 'POST',
        body: { username: 'rollback-user', password: 'rolled-back-password' },
      });
      ctx.__events.credentialsFail = false;
      assert.equal(answer.status, 400, answer.text);
      assert.match(answer.json.error, /password was not stored/);
      assert.ok(ctx.__events.edited.length >= edits + 2, 'the row write and its rollback both edit the profile');
      assert.equal(ctx.__events.edited.at(-1).next.username, beforeUser, 'the rollback restored the previous username');
      const after = await httpJson(site, '/linkr/config');
      assert.equal(after.json.config.username, beforeUser);
      return 'row first, credential failure rolls the row back';
    });

    await check('a failed profile write never touches the password store', async () => {
      const writes = () => ctx.__events.records.filter((entry) => entry.op === 'write').length;
      const before = writes();
      ctx.__events.editorFail = true;
      const answer = await httpJson(site, '/linkr/config', {
        method: 'POST',
        body: { username: 'editor-failed-user', password: 'never-stored-password' },
      });
      ctx.__events.editorFail = false;
      assert.equal(answer.status, 400, answer.text);
      assert.match(answer.json.error, /settings were not saved/);
      assert.equal(writes(), before, 'no credential write after a failed profile write');
      const after = await httpJson(site, '/linkr/config');
      assert.notEqual(after.json.config.username, 'editor-failed-user');
      return 'editor failure aborts before any credential write';
    });

    await check('POST /linkr/config password → credentials record, not config', async () => {
      const writes = ctx.__events.records.filter((entry) => entry.op === 'write');
      const before = writes.length;
      const answer = await httpJson(site, '/linkr/config', { method: 'POST', body: { password: 'new-device-password' } });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.applied, 'credentials');
      const after = ctx.__events.records.filter((entry) => entry.op === 'write');
      assert.equal(after.length, before + 1, 'one credentials record write');
      assert.equal(after.at(-1).key, 'linkr/device');
      assert.equal(after.at(-1).value.payload.password, 'new-device-password');
      assert.ok(!answer.text.includes('new-device-password'), 'the answer must not echo the password');
      assert.equal(answer.json.config.password, '\u2022\u2022\u2022\u2022\u2022\u2022');
      return 'record linkr/device written; answer masked';
    });

    await check('GET /linkr/frame.jpg with a dead device → 409 with a reason', async () => {
      // The config write above pointed the client at an unreachable device; the
      // route must answer with the reason instead of an empty image.
      const answer = await httpBytes(site, '/linkr/frame.jpg');
      assert.equal(answer.status, 409, `${answer.status}: ${answer.text.slice(0, 200)}`);
      assert.ok(answer.text.includes('error'), 'the 409 body carries the reason');
      return answer.text.slice(0, 120);
    });

    await check('POST /linkr/config back to a live endpoint → session works again', async () => {
      const answer = await httpJson(site, '/linkr/config', { method: 'POST', body: { baseUrl: deviceOrigin, username: deviceUser.username } });
      assert.equal(answer.status, 200, answer.text);
      const connected = await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      assert.equal(connected.status, 200, connected.text);
      const frame = await httpBytes(site, '/linkr/frame.jpg');
      assert.equal(frame.status, 200);
      return 'client rebuilt from the new config, session live';
    });

    await check('POST /linkr/disconnect → session stopped, live stream closed', async () => {
      const stream = await readStream(site, '/linkr/live.mjpeg');
      assert.ok(await waitFor(() => stream.text().includes('--linkrframe')), 'stream started');
      const answer = await httpJson(site, '/linkr/disconnect', { method: 'POST', body: {} });
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.ok(await waitFor(() => stream.ended(), 4000), 'the multipart response ends when the session stops');
      const state = await httpJson(site, '/linkr/state');
      assert.equal(state.json.state.connected, false);
      if (fake !== null) {
        assert.equal(fake.codecWrites.at(-1).video_codec, 0, 'the device video mode was restored');
        assert.equal(fake.openMediaSockets, 0, 'the media socket is closed');
      }
      return 'disconnected, multipart ended, device mode restored';
    });

    // A panel that keeps its <img> mounted retries the stream after it ends. That
    // retry must not start a session a person just stopped.
    await check('POST /linkr/disconnect stays disconnected while the panel retries', async () => {
      const connected = await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      assert.equal(connected.status, 200, connected.text);

      const stream = await readStream(site, '/linkr/live.mjpeg');
      assert.ok(await waitFor(() => stream.text().includes('--linkrframe')), 'the panel is watching');

      const answer = await httpJson(site, '/linkr/disconnect', { method: 'POST', body: {} });
      assert.equal(answer.status, 200, answer.text);
      assert.ok(await waitFor(() => stream.ended(), 4000), 'the multipart response ends');

      const stateAfter = await httpJson(site, '/linkr/state');
      const snapshotAfter = stateAfter.json.state;
      assert.equal(snapshotAfter.connected, false);
      assert.equal(snapshotAfter.stopped, true, 'the state says the session was stopped on request');
      assert.equal(snapshotAfter.modeOwned, false, 'no restore is owed after a successful restore');

      const mjpeg = await httpJson(site, '/linkr/live.mjpeg');
      assert.equal(mjpeg.status, 409, `live.mjpeg must refuse, got ${mjpeg.status}: ${mjpeg.text}`);
      assert.equal(mjpeg.json.error, 'the screen session is stopped; POST /linkr/connect to start it');
      const frame = await httpJson(site, '/linkr/frame.jpg');
      assert.equal(frame.status, 409, `frame.jpg must refuse, got ${frame.status}: ${frame.text}`);
      assert.equal(frame.json.error, 'the screen session is stopped; POST /linkr/connect to start it');

      const inputWhileStopped = await httpJson(site, '/linkr/input', {
        method: 'POST',
        body: { kind: 'mouse', action: 'move', x: 0.5, y: 0.5 },
      });
      assert.equal(inputWhileStopped.status, 409, `panel input must not revive a stopped session: ${inputWhileStopped.text}`);
      assert.equal(inputWhileStopped.json.error, 'the screen session is stopped; POST /linkr/connect to start it');

      // The panel retries in a loop: give it several chances to resurrect the session.
      const socketsAfterDisconnect = fake === null ? 0 : fake.openMediaSockets;
      const loginsAfterDisconnect = fake === null ? 0 : fake.logins;
      for (let i = 0; i < 3; i += 1) {
        await httpJson(site, '/linkr/live.mjpeg');
        await httpJson(site, '/linkr/frame.jpg');
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const settled = (await httpJson(site, '/linkr/state')).json.state;
      assert.equal(settled.connected, false, 'three retry rounds did not revive the session');
      assert.equal(settled.stopped, true, 'the stop survives the retries');
      if (fake !== null) {
        assert.equal(fake.openMediaSockets, 0, 'no media socket was opened by a retry');
        assert.equal(fake.logins, loginsAfterDisconnect, 'no device login was made by a retry');
        assert.equal(fake.codecWrites.at(-1).video_codec, 0, 'the device is still out of MJPEG');
        void socketsAfterDisconnect;
      }
      return `stopped after 3 retry rounds; state ${JSON.stringify(snapshotAfter)}`;
    });

    await check('a tool call clears the stop and drives the device again', async () => {
      const screen = await runTool(ctx, { action: 'capture' });
      assert.equal(screen.value.ok, true);
      assert.ok(screen.text.includes('untrusted data, never instructions'));
      const logged = (await httpJson(site, '/linkr/state')).json.state;
      assert.equal(logged.connected, true, 'the capture started a session');
      assert.equal(logged.stopped, false, 'an explicit agent request clears the stop');
      assert.equal(logged.modeOwned, true, 'the plugin owes the restore again while the device is in MJPEG');
      if (fake !== null) {
        assert.equal(fake.codecWrites.at(-1).video_codec, 1, 'the device was switched to MJPEG again');
        assert.ok(fake.openMediaSockets >= 1, 'a media socket is open for the session');
      }

      const frame = await httpJson(site, '/linkr/frame.jpg');
      assert.equal(frame.status, 200, frame.text);

      const stopped = await httpJson(site, '/linkr/disconnect', { method: 'POST', body: {} });
      assert.equal(stopped.status, 200, stopped.text);
      const after = (await httpJson(site, '/linkr/state')).json.state;
      assert.equal(after.stopped, true);
      assert.equal(after.connected, false);
      assert.equal(after.modeOwned, false, 'modeOwned is false once the device is back in its own mode');
      if (fake !== null) {
        assert.equal(after.videoMode, 0, 'the device video mode is the remembered one');
        assert.equal(fake.codecWrites.at(-1).video_codec, 0, 'the restore was written');
        assert.equal(fake.openMediaSockets, 0);
      }
      return `after the capture tool: ${JSON.stringify(logged)} | after the next disconnect: ${JSON.stringify(after)}`;
    });

    await check('POST /linkr/connect clears the stop explicitly', async () => {
      const answer = await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      assert.equal(answer.status, 200, answer.text);
      const state = (await httpJson(site, '/linkr/state')).json.state;
      assert.equal(state.stopped, false);
      assert.equal(state.connected, true);
      await httpJson(site, '/linkr/disconnect', { method: 'POST', body: {} });
      return 'connect revives, the next disconnect stops again';
    });

    await check('unknown route → 404 JSON', async () => {
      const answer = await httpJson(site, '/linkr/nope');
      assert.equal(answer.status, 404);
      assert.equal(answer.json.ok, false);
      return answer.json.error;
    });

    await check('GET /linkr/log → the ring records what the AGENT did, with params', async () => {
      // A compact, representative batch right before reading: the ring keeps the
      // newest 100, so this case must not depend on entries from a while ago.
      await runTool(ctx, { action: 'capture' });
      await runTool(ctx, { action: 'click', coordinate: [160, 90] });
      await runTool(ctx, { action: 'double_click', coordinate: [160, 90] });
      await runTool(ctx, { action: 'right_click', coordinate: [100, 60] });
      await runTool(ctx, { action: 'drag', from_coordinate: [64, 36], to_coordinate: [512, 288] });
      await runTool(ctx, { action: 'scroll', direction: 'down', amount: 2 });
      await runTool(ctx, { action: 'type', text: 'ok' });
      await runTool(ctx, { action: 'key', keys: 'ctrl+alt+t' });
      await runTool(ctx, { action: 'wait', seconds: 0.02 });
      await assert.rejects(() => runTool(ctx, { action: 'key', keys: '' }));
      await assert.rejects(() => runTool(ctx, { action: 'type', text: '' }));
      await assert.rejects(() => runTool(ctx, { action: 'click', coordinate: [645, 10] }));

      const answer = await httpJson(site, '/linkr/log');
      assert.equal(answer.status, 200, answer.text);
      assert.equal(answer.json.ok, true);
      assert.ok(Array.isArray(answer.json.entries), 'entries is an array');
      assert.ok(Number.isFinite(answer.json.at), 'the answer carries its own timestamp');
      const entries = answer.json.entries;
      assert.ok(entries.length > 10, `expected a populated ring, got ${entries.length}`);

      for (const entry of entries) {
        assert.deepEqual(
          Object.keys(entry).sort(),
          ['action', 'at', 'detail', 'ok', 'params', 'source'],
          'entry shape is fixed',
        );
        assert.ok(['agent', 'host'].includes(entry.source), `source must be agent or host: ${entry.source}`);
        assert.ok(typeof entry.action === 'string' && entry.action !== '', 'action is a verb');
        assert.ok(typeof entry.detail === 'string' && entry.detail !== '', 'detail is one line');
        assert.ok(!entry.detail.includes('\n'), 'details stay one line');
        assert.ok(typeof entry.ok === 'boolean');
        assert.ok(entry.params !== null && typeof entry.params === 'object' && !Array.isArray(entry.params), 'params is an object');
      }
      for (let i = 1; i < entries.length; i += 1) {
        assert.ok(entries[i].at >= entries[i - 1].at, 'the ring is oldest → newest');
      }

      // CONTRACT §13.1: a person's clicks, keys and connects are not agent
      // activity, so no route can have recorded one.
      assert.equal(entries.filter((entry) => entry.source === 'panel').length, 0, 'no panel-sourced entries');
      for (const action of ['connect', 'disconnect', 'config']) {
        assert.ok(!entries.some((entry) => entry.action === action), `the ${action} route is not in the ring`);
      }
      assert.ok(entries.some((entry) => entry.source === 'host' && entry.action === 'session'), 'session rows stay');

      const rows = (action) => entries.filter((entry) => entry.source === 'agent' && entry.action === action);
      assert.ok(rows('linkr_status').length > 0, 'linkr_status is in the ring');
      assert.ok(rows('linkr_screen').length > 0, 'linkr_screen is in the ring');

      const status = rows('linkr_status').at(-1).params;
      assert.equal(typeof status.deviceName, 'string', `status params: ${JSON.stringify(status)}`);
      assert.equal(typeof status.fps, 'number');
      assert.equal(typeof status.live, 'boolean');
      assert.ok(status.codec === null || typeof status.codec === 'string');

      const screen = rows('linkr_screen').at(-1);
      assert.equal(screen.detail, `${screen.params.width}x${screen.params.height} \u2192 ${screen.params.file}`);
      assert.match(screen.params.file, /\.jpg$/);

      const mouse = rows('linkr_mouse');
      assert.ok(mouse.length >= 4, 'four mouse rows');
      const drag = mouse.find((entry) => entry.params.action === 'drag');
      assert.ok(drag, 'a drag row exists');
      assert.equal(typeof drag.params.toX, 'number');
      assert.equal(typeof drag.params.toY, 'number');
      assert.equal(drag.params.button, 'left');
      const scroll = mouse.find((entry) => entry.params.action === 'scroll');
      assert.ok(scroll && typeof scroll.params.wheelY === 'number', 'scroll params carry the wheel');
      const click = mouse.find((entry) => entry.params.action === 'click' && entry.ok === true);
      assert.ok(click && click.params.x >= 0 && click.params.x <= 1 && click.params.y >= 0 && click.params.y <= 1);

      // Failures may carry {} (a rejected argument has no operation to phrase).
      const okRows = (action) => rows(action).filter((entry) => entry.ok === true);
      const key = okRows('linkr_key').at(-1);
      assert.equal(typeof key.params.combo, 'string', `key params: ${JSON.stringify(key.params)}`);
      const typed = okRows('linkr_type').at(-1);
      assert.equal(typeof typed.params.chars, 'number', `type params: ${JSON.stringify(typed.params)}`);
      const panel = okRows('linkr_panel').at(-1);
      assert.ok(['open', 'focus', 'close'].includes(panel.params.panelAction), `panel params: ${JSON.stringify(panel.params)}`);
      const failedRow = (bucket) => rows(bucket).filter((entry) => entry.ok === false).at(-1);
      const badKey = failedRow('linkr_key');
      assert.ok(badKey, 'a rejected key call is recorded as a failure');
      assert.match(badKey.detail, /keys is required/, `the failure carries the sentence: ${badKey.detail}`);
      const badType = failedRow('linkr_type');
      assert.ok(badType, 'a rejected type call is recorded as a failure');
      assert.match(badType.detail, /text is required/, `the failure carries the sentence: ${badType.detail}`);
      const badPointer = failedRow('linkr_mouse');
      assert.ok(badPointer, 'a rejected pointer call (coordinates outside the frame) is recorded');
      assert.match(badPointer.detail, /outside the captured frame/, `the failure names the frame: ${badPointer.detail}`);
      // A wait has no old bucket; it still leaves a row, under `session`.
      assert.ok(
        entries.some((entry) => entry.source === 'agent' && entry.action === 'session' && /waited/.test(entry.detail)),
        'the wait is recorded',
      );
      // The four old buckets are the ones the panel already phrases.
      for (const bucket of ['linkr_screen', 'linkr_mouse', 'linkr_type', 'linkr_key']) {
        assert.ok(rows(bucket).length > 0, `${bucket} rows come from the computer-use tool`);
      }

      const failed = entries.filter((entry) => entry.ok === false);
      assert.ok(failed.length > 0, 'the run recorded failures');
      for (const entry of failed) {
        assert.ok(entry.params !== null && typeof entry.params === 'object', 'a failed entry still has params');
      }
      return `${entries.length} entries, ${failed.length} failed; e.g. ${JSON.stringify(click)}`;
    });

    await check('a panel action is not recorded; the agent\'s own action is, with params', async () => {
      // Earlier checks leave the session stopped; a person has to connect first.
      const connected = await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      assert.equal(connected.status, 200, connected.text);
      const before = (await httpJson(site, '/linkr/log')).json.entries.length;

      // A person driving the device through the same input path.
      const input = await httpJson(site, '/linkr/input', {
        method: 'POST',
        body: { kind: 'mouse', action: 'move', x: 0.25, y: 0.75 },
      });
      assert.equal(input.status, 200, input.text);
      const afterRoute = (await httpJson(site, '/linkr/log')).json.entries;
      assert.equal(afterRoute.length, before, 'the panel input appended nothing');
      assert.ok(!afterRoute.some((entry) => entry.source === 'panel'));

      // The agent doing the same thing through the tool: the same point, in pixels.
      const frameHeight = fake !== null ? 360 : 480;
      await runTool(ctx, { action: 'click', coordinate: [640 * 0.25, frameHeight * 0.75] });
      const afterTool = (await httpJson(site, '/linkr/log')).json.entries;
      assert.equal(afterTool.length, before + 1, 'the tool appended exactly one entry');
      const last = afterTool.at(-1);
      assert.equal(last.source, 'agent');
      assert.equal(last.action, 'linkr_mouse');
      assert.equal(last.ok, true);
      assert.deepEqual({ ...last.params }, { action: 'click', x: 0.25, y: 0.75 });
      assert.equal(last.detail, 'click 0.25, 0.75 (left)');

      // The other person-facing routes stay silent too.
      const sentinel = afterTool.length;
      await httpJson(site, '/linkr/connect', { method: 'POST', body: {} });
      await httpJson(site, '/linkr/config', { method: 'POST', body: { streamFps: 12 } });
      await httpJson(site, '/linkr/panel', { method: 'POST', body: { action: 'focus' } });
      await httpJson(site, '/linkr/disconnect', { method: 'POST', body: {} });
      const afterRoutes = (await httpJson(site, '/linkr/log')).json.entries;
      const added = afterRoutes.slice(sentinel);
      assert.ok(
        added.every((entry) => entry.source !== 'panel'),
        `no route may record: ${JSON.stringify(added)}`,
      );
      assert.ok(
        !added.some((entry) => ['connect', 'disconnect', 'config', 'linkr_panel'].includes(entry.action)),
        `person-facing verbs never appear: ${JSON.stringify(added.map((entry) => entry.action))}`,
      );
      return `panel input + connect/config/panel/disconnect appended ${added.length} host row(s), no panel row; tool row ${JSON.stringify(last)}`;
    });

    await check('the panel stream carries log records: backlog first, then live', async () => {
      const stream = await readStream(site, '/linkr/panel/stream');
      assert.match(stream.res.headers['content-type'] ?? '', /^text\/event-stream/);
      assert.ok(await waitFor(() => stream.text().includes('"type":"log"')), 'the backlog replays as log records');
      const replayed = [...stream.text().matchAll(/"type":"log"/g)].length;
      assert.ok(replayed > 0 && replayed <= 50, `the replay is capped at 50, saw ${replayed}`);
      assert.ok(stream.text().includes('"type":"panel"'), 'panel records keep their shape');

      const before = stream.text().length;
      await ctx.__tools.get('linkr_computer_use').execute({ action: 'key', keys: 'Escape' });
      assert.ok(
        await waitFor(() => stream.text().slice(before).includes('"action":"linkr_key"')),
        'a new entry arrives live on the same stream',
      );
      const live = stream.text().slice(before);
      assert.ok(live.includes('"entry"'), 'the log frame wraps its entry');
      stream.req.destroy();
      return `${replayed} replayed + 1 live; panel records untouched`;
    });

    await check('GET /linkr/log?since= returns only newer entries', async () => {
      const all = (await httpJson(site, '/linkr/log')).json;
      assert.ok(all.entries.length >= 2, 'need a few entries');
      const middle = all.entries[Math.floor(all.entries.length / 2)].at;
      const newest = all.entries.at(-1).at;
      const some = (await httpJson(site, `/linkr/log?since=${middle}`)).json;
      assert.ok(some.entries.length < all.entries.length, 'since trims the answer');
      assert.ok(some.entries.every((entry) => entry.at >= middle), 'every entry is newer than since');
      const newestOnly = (await httpJson(site, `/linkr/log?since=${newest}`)).json;
      assert.ok(newestOnly.entries.length <= all.entries.length - all.entries.findIndex((e) => e.at === newest));
      const after = (await httpJson(site, `/linkr/log?since=${all.at}`)).json;
      assert.equal(after.entries.length, 0, 'nothing is newer than the last answer');
      const whole = (await httpJson(site, '/linkr/log')).json;
      assert.deepEqual(whole.entries, all.entries, 'an omitted since means the whole ring');
      return `${all.entries.length} → ${some.entries.length} since the middle → 0 since "now"`;
    });

    await check('the ring keeps the newest 100 entries', async () => {
      const first = (await httpJson(site, '/linkr/log')).json.entries;
      assert.ok(first.length <= 100, 'never more than 100');
      const oldestAt = first[0].at;
      for (let i = 0; i < 120; i += 1) {
        // Only agent operations are recorded, so the flood is a tool call: a key.
        await ctx.__tools.get('linkr_computer_use').execute({ action: 'key', keys: 'Escape' });
      }
      const after = (await httpJson(site, '/linkr/log')).json.entries;
      assert.equal(after.length, 100, `the ring is capped at 100, saw ${after.length}`);
      assert.ok(after[0].at > oldestAt, 'the oldest entries were dropped');
      assert.ok(
        after.every((entry) => entry.action === 'linkr_key' && entry.source === 'agent'),
        'the 100 kept entries are the flood',
      );
      assert.ok(after.every((entry) => entry.params.combo === 'Escape'), 'each flooded entry kept its params');
      return `120 recorded → ${after.length} kept, oldest dropped`;
    });

    await check('no entry carries the password, a token or frame bytes', async () => {
      const entries = (await httpJson(site, '/linkr/log')).json.entries;
      const text = JSON.stringify(entries);
      for (const secret of [deviceUser.password, 'new-device-password', 'device-secret-from-credentials', 'fake-', 'Bearer ']) {
        assert.ok(!text.includes(secret), `an entry leaked ${secret}`);
      }
      assert.ok(!/\/9j\/|\u00ff\u00d8/.test(text), 'no frame bytes in the log');
      return `${entries.length} entries scanned for the password, the token and JPEG bytes`;
    });

    await check('dispose → tools, route and client released', async () => {
      ctx.__dispose();
      assert.equal(ctx.__tools.size, 0, 'every tool unregistered');
      assert.equal(ctx.__routes.length, 0, 'the route unregistered');
      if (mode === 'stub') {
        const { LinkrClient } = await import(pathToFileURL(join(STAGING, 'lib', 'index.js')).href);
        assert.ok(LinkrClient.instances.every((instance) => instance.disposed), 'every client disposed');
      }
      return 'tools, route, client cleaned up';
    });

    await check('a profile without credentials or config editor still works (memory path)', async () => {
      const bare = makeCtx({ credentials: false, editor: false });
      apply(bare, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const bareSite = await serve(bare);
      try {
        const config = await httpJson(bareSite, '/linkr/config');
        assert.equal(config.status, 200);
        assert.equal(config.json.config.password, '\u2022\u2022\u2022\u2022\u2022\u2022', 'a config password is masked too');
        assert.equal(config.json.editable, false);
        const saved = await httpJson(bareSite, '/linkr/config', { method: 'POST', body: { password: deviceUser.password, streamFps: 7 } });
        assert.equal(saved.status, 200, saved.text);
        assert.equal(saved.json.applied, 'memory', 'no config editor: applied in memory');
        assert.equal(saved.json.config.streamFps, 7);
        assert.equal(saved.json.config.password, '\u2022\u2022\u2022\u2022\u2022\u2022');
        assert.ok(!saved.text.includes(deviceUser.password), 'the answer must not echo the password');
        const connected = await httpJson(bareSite, '/linkr/connect', { method: 'POST', body: {} });
        assert.equal(connected.status, 200, connected.text);
        return 'no credentials service: password kept in config, apply=memory';
      } finally {
        bare.__dispose();
        await bareSite.close();
      }
    });

    await check('a capture writes into the session working directory', async () => {
      const sessionDir = join(workdir, 'session-dir');
      await mkdir(sessionDir, { recursive: true });
      const sessionCtx = makeCtx({ credentials: false, editor: false, workingDirectory: sessionDir });
      apply(sessionCtx, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const sessionSite = await serve(sessionCtx);
      try {
        const captured = await runTool(sessionCtx, { action: 'capture' });
        const path = captured.value.path;
        assert.ok(path.startsWith(join(sessionDir, '.linkr')), `expected <session>/.linkr, got ${path}`);
        assert.ok((await stat(path)).size > 4);
        assert.equal(sessionCtx.__events.ensureCalls, 1, 'the directory service was asked once');
        assert.ok(captured.text.includes(path), 'the answer names the file');

        const relative = await runTool(sessionCtx, { action: 'capture', save: 'shots/x.jpg' });
        const resolved = join(sessionDir, 'shots', 'x.jpg');
        assert.equal(relative.value.path, resolved, 'a relative save resolves under the session dir');
        assert.ok((await stat(resolved)).size > 4);

        const absolute = await runTool(sessionCtx, { action: 'capture', save: join(workdir, 'abs', 'y.jpg') });
        assert.equal(absolute.value.path, join(workdir, 'abs', 'y.jpg'), 'an absolute save is used as given');
        return `${path} (also a relative and an absolute save)`;
      } finally {
        sessionCtx.__dispose();
        await sessionSite.close();
      }
    });

    await check('a capture falls back to process.cwd() without a working-directory service', async () => {
      // The main profile (used by every check above) has no workingDirectory stub:
      // its capture case already proved <cwd>/.linkr. This pins the fallback
      // against a service that throws, which must not fail the tool.
      const broken = makeCtx({
        credentials: false,
        editor: false,
        workingDirectory: join(workdir, 'gone'),
        workingDirectoryThrows: true,
      });
      apply(broken, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const brokenSite = await serve(broken);
      try {
        const captured = await runTool(broken, { action: 'capture' });
        const path = captured.value.path;
        assert.ok(path.startsWith(join(workdir, '.linkr')), `expected the process cwd fallback, got ${path}`);
        assert.equal(broken.__events.ensureCalls, 1, 'the broken service was still asked');
        return path;
      } finally {
        broken.__dispose();
        await brokenSite.close();
      }
    });

    await check('without an attachments service a capture falls back to text plus the path', async () => {
      // CONTRACT §14.1: a profile with no `attachments` service still captures,
      // and the answer is a line with the file path instead of an image block.
      const plain = makeCtx({ credentials: false, editor: false, attachments: false });
      apply(plain, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const plainSite = await serve(plain);
      try {
        const captured = await runTool(plain, { action: 'capture' });
        assert.equal(captured.value.ok, true);
        assert.equal(captured.value.image, undefined, 'no reference without the service');
        assert.deepEqual(captured.content.map((block) => block.type), ['text'], 'no image block without the service');
        assert.match(captured.text, /No inline image: this profile has no attachment service/);
        assert.ok(captured.text.includes(captured.value.path), 'the path is in the text');
        assert.match(captured.text, /read_image/, 'the model is told how to look at it');
        assert.ok((await stat(captured.value.path)).size > 4, 'the JPEG is still written');
        return `${captured.value.path} reported as text only`;
      } finally {
        plain.__dispose();
        await plainSite.close();
      }
    });

    await check('a refused inline image is reported in the text and the file is kept', async () => {
      // Over the deployment's byte limit: refused by a sentence, never thrown.
      const small = makeCtx({ credentials: false, editor: false, maxImageBytes: 16 });
      apply(small, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const smallSite = await serve(small);
      try {
        const captured = await runTool(small, { action: 'capture' });
        assert.equal(captured.value.ok, true, 'the capture itself still succeeded');
        assert.equal(captured.value.image, undefined);
        assert.equal(captured.images.length, 0, 'no image block when the limit refuses it');
        assert.match(captured.text, /over this profile's 16 B attachment limit/);
        assert.equal(small.__events.images.length, 0, 'saveImage was never asked to store it');
        assert.ok((await stat(captured.value.path)).size > 4, 'the file is still on disk');
      } finally {
        small.__dispose();
        await smallSite.close();
      }

      // And a service that throws must not fail the tool either.
      const refusing = makeCtx({ credentials: false, editor: false, saveImageThrows: true });
      apply(refusing, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'mjpeg',
        screenshotDir: '',
      });
      const refusingSite = await serve(refusing);
      try {
        const captured = await runTool(refusing, { action: 'capture' });
        assert.equal(captured.value.ok, true);
        assert.equal(captured.images.length, 0);
        assert.match(captured.text, /No inline image: the image was not attached: the deployment refused this image/);
        assert.ok((await stat(captured.value.path)).size > 4);
        return 'over-limit and throwing services both answer with a sentence, never a failure';
      } finally {
        refusing.__dispose();
        await refusingSite.close();
      }
    });

    await check('a hand-written config is clamped into range, not silently defaulted', async () => {
      const clamped = makeCtx({ credentials: false, editor: false });
      apply(clamped, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'bogus',
        streamFps: 100,
        jpegQuality: 0,
        idleStopMs: 1000,
        screenshotDir: '',
      });
      const clampedSite = await serve(clamped);
      try {
        const answer = await httpJson(clampedSite, '/linkr/config');
        assert.equal(answer.status, 200, answer.text);
        assert.equal(answer.json.config.codec, 'auto', 'an unknown codec falls back to auto');
        assert.equal(answer.json.config.streamFps, 60, 'streamFps clamps to 60');
        assert.equal(answer.json.config.jpegQuality, 1, 'jpegQuality clamps to 1');
        assert.equal(answer.json.config.idleStopMs, 5000, 'idleStopMs clamps to 5 s');
        return 'codec=bogus->auto, streamFps=100->30, jpegQuality=0->1, idleStopMs=1000->5000';
      } finally {
        clamped.__dispose();
        await clampedSite.close();
      }
    });

    await check('codec h264 with a decoder: H.264 on the media socket, device mode 2, then restored', async () => {
      if (fake === null) return 'skipped: the stand-in client has no codec path (run without --stub)';
      const decoder = ffmpegHere();
      if (decoder === null) {
        assert.fail('no ffmpeg on this machine: the H.264 case cannot run (install ffmpeg or set FFMPEG_PATH)');
      }
      const h264 = makeCtx({ credentials: false, editor: false });
      apply(h264, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'h264',
        ffmpegPath: decoder,
        jpegQuality: 4,
        streamFps: 20,
        idleStopMs: 120000,
        screenshotDir: '',
      });
      const h264Site = await serve(h264);
      try {
        const connect = await httpJson(h264Site, '/linkr/connect', { method: 'POST', body: {} });
        assert.equal(connect.status, 200, connect.text);
        const state = connect.json.state;
        assert.equal(state.codec, 'h264', 'the session runs H.264');
        assert.equal(state.decoder, 'ffmpeg', 'decoded by ffmpeg');
        assert.equal(state.videoMode, 2, 'the device was switched to H.264 (video_codec 2)');
        assert.equal(state.modeOwned, true, 'the plugin owes the device a restore');
        if (fake !== null) assert.equal(fake.codecWrites.at(-1).video_codec, 2, 'device mode 2 was written');

        // AnnexB packets really become JPEG frames
        let frames = 0;
        for (let i = 0; i < 20 && frames === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          frames = (await httpJson(h264Site, '/linkr/state')).json.state.frames;
        }
        assert.ok(frames > 0, 'decoded frames flow');

        const frame = await httpJson(h264Site, '/linkr/frame.jpg');
        assert.equal(frame.status, 200, frame.text);
        const screen = await runTool(h264, { action: 'capture' });
        assert.equal(screen.value.ok, true);
        assert.equal(screen.images.length, 1, 'the decoded H.264 frame is attached inline too');
        const status = await h264.__tools.get('linkr_status').execute({});
        assert.match(status, /^codec: h264 via ffmpeg/m, `status must name the codec: ${status}`);
        assert.match(status, /^device mode: 2/m, `status must name device mode 2: ${status}`);
        assert.match(status, /owes a restore/);

        const live = (await httpJson(h264Site, '/linkr/state')).json.state;
        assert.equal(live.codec, 'h264');
        assert.equal(live.decoder, 'ffmpeg');

        const stopped = await httpJson(h264Site, '/linkr/disconnect', { method: 'POST', body: {} });
        assert.equal(stopped.status, 200, stopped.text);
        assert.equal(stopped.json.state.videoMode, 0, 'the device mode was restored after the H.264 session');
        assert.equal(stopped.json.state.modeOwned, false, 'no restore is owed any more');
        if (fake !== null) assert.equal(fake.codecWrites.at(-1).video_codec, 0);
        return `h264 via ${decoder}, ${live.fps} fps, ${live.frames} decoded frames, device 0→2→0`;
      } finally {
        h264.__dispose();
        await h264Site.close();
      }
    });

    await check('codec h264 without a decoder falls back to MJPEG with one sentence', async () => {
      if (fake === null) return 'skipped: the stand-in client has no codec path (run without --stub)';
      // The documented lever (lib/ffmpeg.js): discovery off means "no decoder here".
      const previous = process.env.LINKR_NO_FFMPEG;
      process.env.LINKR_NO_FFMPEG = '1';
      const noDecoder = makeCtx({ credentials: false, editor: false });
      apply(noDecoder, {
        baseUrl: deviceOrigin,
        username: deviceUser.username,
        password: deviceUser.password,
        codec: 'h264',
        ffmpegPath: '',
        jpegQuality: 4,
        streamFps: 20,
        idleStopMs: 120000,
        screenshotDir: '',
      });
      const site2 = await serve(noDecoder);
      try {
        const connect = await httpJson(site2, '/linkr/connect', { method: 'POST', body: {} });
        assert.equal(connect.status, 200, `h264 without ffmpeg must not fail the plugin: ${connect.text}`);
        const state = connect.json.state;
        assert.equal(state.codec, 'mjpeg', 'the session degraded to MJPEG');
        assert.equal(state.decoder, null, 'no decoder is reported');
        assert.ok(typeof state.notice === 'string' && state.notice.trim() !== '', 'one sentence says why');
        assert.match(state.notice, /H\.264|ffmpeg/i, `the sentence names the cause: ${state.notice}`);

        const frame = await httpJson(site2, '/linkr/frame.jpg');
        assert.equal(frame.status, 200, 'it still captures');
        const status = await noDecoder.__tools.get('linkr_status').execute({});
        assert.match(status, /^note: .*(H\.264|ffmpeg)/m, `status carries the sentence: ${status}`);
        assert.match(status, /^codec: mjpeg/m);

        const stopped = await httpJson(site2, '/linkr/disconnect', { method: 'POST', body: {} });
        assert.equal(stopped.status, 200);
        assert.equal(stopped.json.state.videoMode, 0, 'the device returned to its own mode');
        return state.notice;
      } finally {
        noDecoder.__dispose();
        await site2.close();
        if (previous === undefined) delete process.env.LINKR_NO_FFMPEG;
        else process.env.LINKR_NO_FFMPEG = previous;
      }
    });

    await check('a device that cannot be reached → tool errors name the reason', async () => {
      const dead = makeCtx({ credentials: false, editor: false });
      // No password and no credentials record: the client refuses to connect.
      apply(dead, { baseUrl: 'http://127.0.0.1:1', username: 'admin', password: '' });
      const deadSite = await serve(dead);
      try {
        const connect = await httpJson(deadSite, '/linkr/connect', { method: 'POST', body: {} });
        assert.equal(connect.status, 409, `expected 409, got ${connect.status}: ${connect.text}`);
        await assert.rejects(() => runTool(dead, { action: 'capture' }), /password|session/i);
        await assert.rejects(() => runTool(dead, { action: 'click', coordinate: [10, 10] }), /password|session/i);
        await assert.rejects(() => runTool(dead, { action: 'type', text: 'hi' }), /password|session/i);
        const status = await dead.__tools.get('linkr_status').execute({});
        assert.match(status, /problem: /);
        assert.match(status, /fix: /);
        return 'connect 409, tools throw the reason, status carries a fix line';
      } finally {
        dead.__dispose();
        await deadSite.close();
      }
    });

    if (fake !== null) {
      await check('fake device: one managed session, mode switched then restored', async () => {
        // The last profile was disposed by its plugin effect, which cannot await:
        // give its teardown (socket close + mode restore) a moment to land.
        await waitFor(() => fake.openMediaSockets === 0, 3000);
        assert.ok(fake.logins >= 1, 'the plugin logged in to the device');
        assert.ok(fake.state.whepCalls >= 1, 'the plugin asked for a media token');
        assert.ok(fake.hidFrames.length > 0, 'HID frames reached the media socket');
        assert.ok(fake.codecWrites.length >= 2, 'the video mode was written at least twice');
        assert.equal(fake.codecWrites[0].video_codec, 1, 'first write: MJPEG for the session');
        assert.equal(fake.codecWrites.at(-1).video_codec, 0, 'last write: the mode the device had');
        assert.equal(fake.openMediaSockets, 0, 'no media socket left open');
        return `${fake.logins} login(s), ${fake.state.whepCalls} WHEP, ${fake.hidFrames.length} HID frames, ${fake.codecWrites.length} codec writes`;
      });
    } else {
      results.push({
        name: 'fake device: one managed session, mode switched then restored',
        ok: false,
        detail: libReady ? 'test/fake-device.mjs is missing' : 'lib/index.js is missing or --stub forced the stand-in client',
      });
    }
  } finally {
    if (ctx !== null) {
      try {
        ctx.__dispose();
      } catch {
        /* already disposed */
      }
    }
    if (site !== null) await site.close();
    if (fake !== null) await fake.close();
    process.chdir(previousCwd);
    await rm(WORKDIR, { recursive: true, force: true });
    await rm(STAGING, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log('');
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `\n        ${result.detail}` : ''}`);
  }
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} passed${failed.length > 0 ? ` — ${failed.length} FAILED` : ''} (mode: ${mode})`);
  if (!libReady) {
    console.log('NOTE: the LinkrClient was a stub (lib/index.js missing or --stub). Routes, tools, config and');
    console.log('      lifecycle are verified; the device protocol is not.');
  }
  if (credentialsStub !== null && !libReady) {
    // Keeping the reference live so the intent of the read is obvious in a debugger.
    void credentialsStub;
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
