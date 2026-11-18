#!/usr/bin/env node
/**
 * Smoke check for the OpenCode 2 native plugin (`opencode/plugin`).
 *
 * The plugin imports `@opencode/plugin` at load time, so this skips cleanly when
 * that dependency has not been installed (a bare checkout without
 * `npm install` in `opencode/plugin/`). When it is installed, it exercises the
 * parts that do not need OpenCode itself: the registration surface, config
 * precedence (plugins options over LINKR_* environment) and the MCP → OpenCode
 * content mapping.
 *
 *   node scripts/opencode-plugin-smoke.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'opencode', 'plugin');
const API = join(PLUGIN, 'node_modules', '@opencode', 'plugin', 'package.json');

if (!existsSync(API)) {
  console.log('SKIP  opencode/plugin dependencies are not installed (cd opencode/plugin && npm install)');
  process.exit(0);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

const plugin = await import(pathToFileURL(join(PLUGIN, 'index.js')).href);
const settingsModule = await import(pathToFileURL(join(PLUGIN, 'settings.js')).href);
const rpcSchema = await import(pathToFileURL(join(PLUGIN, 'gui', 'rpc-schema.js')).href);

check('the package exports a Plugin with the expected id', () => {
  if (plugin.id !== 'opencode-linkr') throw new Error(`id is ${plugin.id}`);
  if (typeof plugin.default?.setup !== 'function') throw new Error('default export has no setup()');
  if (plugin.default?.id !== 'opencode-linkr') throw new Error('Plugin.define id mismatch');
});

check('all Linkr tools are registered (including the panel)', () => {
  const ids = [...(plugin.TOOL_IDS ?? [])].sort();
  const expected = ['linkr_computer_use', 'linkr_panel', 'linkr_status'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) throw new Error(`TOOL_IDS is ${JSON.stringify(ids)}`);
});

check('the panel RPC exposes the connection settings', () => {
  const definition = rpcSchema.panelRpcDefinition();
  for (const method of ['open', 'state', 'close', 'settings', 'saveSettings']) {
    if (!definition.methods?.[method]) throw new Error(`RPC method ${method} is missing`);
  }
  const save = definition.methods.saveSettings.input;
  if (!save.properties?.baseUrl) throw new Error('saveSettings does not accept a baseUrl');
});

check('settings validate, persist and merge', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const scratch = await mkdtemp(join(tmpdir(), 'linkr-settings-'));
  const file = join(scratch, 'settings.json');
  try {
    const saved = await settingsModule.writeSettings({ baseUrl: 'http://linkr.test', username: 'admin', password: 'secret', codec: 'h264' }, file);
    if (saved.version !== settingsModule.SETTINGS_VERSION) throw new Error('version is missing');
    const read = await settingsModule.readSettings(file);
    if (read.baseUrl !== 'http://linkr.test' || read.codec !== 'h264') throw new Error(`read back ${JSON.stringify(read)}`);
    const clean = settingsModule.validatePatch({ baseUrl: 'http://linkr.test:8080/' });
    if (clean.baseUrl !== 'http://linkr.test:8080') throw new Error(`baseUrl normalised to ${clean.baseUrl}`);
    let threw = false;
    try { settingsModule.validatePatch({ baseUrl: 'http://linkr.test/path' }); } catch { threw = true; }
    if (!threw) throw new Error('a baseUrl with a path must be rejected');
    const view = settingsModule.publicSettings({ client: { baseUrl: 'http://a', username: 'u', codec: 'auto', password: 'x' } }, {});
    if (!view.hasPassword || view.passwordSource !== 'environment') throw new Error(`publicSettings ${JSON.stringify(view)}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

check('plugin options override the LINKR_* environment', () => {
  const config = plugin.configFromOptions(
    { baseUrl: 'http://from-options', username: 'admin' },
    { LINKR_CONFIG_FILE: '/nonexistent/linkr-smoke.json', LINKR_BASE_URL: 'http://from-env', LINKR_USERNAME: 'env-admin', LINKR_PASSWORD: 'x' },
  );
  if (config.client.baseUrl !== 'http://from-options') throw new Error(`baseUrl is ${config.client.baseUrl}`);
  if (config.client.username !== 'admin') throw new Error(`username is ${config.client.username}`);
  if (config.client.password !== 'x') throw new Error('the environment password was lost');
});

check('a capture inside the project becomes a file block, outside it does not', () => {
  const result = {
    content: [{ type: 'text', text: 'Captured the controlled host screen (1920x1080) at /p/.linkr/capture.jpg.' }],
    value: { path: '/p/.linkr/capture.jpg' },
  };
  const inside = plugin.toContent(result, { projectDir: '/p' });
  if (inside[0]?.type !== 'file' || !String(inside[0].uri).startsWith('file://')) throw new Error(`inside content is ${JSON.stringify(inside)}`);
  const outside = plugin.toContent(result, { projectDir: '/other' });
  if (outside.some((block) => block.type === 'file')) throw new Error('an out-of-project capture must not be file-referenced');
  if (!outside.some((block) => block.type === 'text')) throw new Error('the text block is missing');
});

check('nativeTools maps a callTool result and surfaces failures', async () => {
  const ok = plugin.nativeTools({ callTool: async (name) => ({ content: [{ type: 'text', text: name }], value: {} }) });
  if (ok.length !== 2) throw new Error(`expected 2 native tools, got ${ok.length}`);
  const status = await ok.find((tool) => tool.name === 'linkr_status').execute({}, {});
  if (status.content[0].text !== 'linkr_status') throw new Error('the status tool did not forward the call');
  const failing = plugin.nativeTools({ callTool: async () => ({ content: [{ type: 'text', text: 'device is not reachable' }], isError: true }) });
  let threw = false;
  try {
    await failing[0].execute({}, {});
  } catch (error) {
    threw = /device is not reachable/.test(String(error.message));
  }
  if (!threw) throw new Error('an isError result must throw with the text');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
