#!/usr/bin/env node
/**
 * Smoke check for the OpenCode desktop GUI part (`dist/gui-experimental.cjs`).
 *
 * The bundle is loaded by OpenCode's desktop windows, which provide
 * `@opencode/plugin/gui`, `@opencode/plugin/rpc` and `solid-js` themselves.
 * Outside that host those modules are not loadable, so this stubs them, requires
 * the bundle, and runs its `setup` against a fake GUI context: enough to prove
 * the bundle shape, the i18n copy and the panel/command/menu registrations
 * without a desktop window.
 *
 *   node scripts/opencode-gui-smoke.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'opencode', 'plugin', 'dist', 'gui-experimental.cjs');

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

check('the GUI bundle exists and only requires host-provided modules', () => {
  const source = readFileSync(BUNDLE, 'utf8');
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  const allowed = new Set(['solid-js', 'solid-js/web', '@opencode/plugin/gui', '@opencode/plugin/rpc']);
  for (const name of requires) if (!allowed.has(name)) throw new Error(`unexpected external ${name}`);
  if (requires.length === 0) throw new Error('the bundle requires nothing; expected host modules');
});

const scratch = mkdtempSync(join(tmpdir(), 'linkr-gui-smoke-'));
const stubs = {
  '@opencode/plugin/gui': join(scratch, 'gui.cjs'),
  '@opencode/plugin/rpc': join(scratch, 'rpc.cjs'),
  'solid-js': join(scratch, 'solid.cjs'),
  'solid-js/web': join(scratch, 'solid-web.cjs'),
};

writeFileSync(
  stubs['@opencode/plugin/gui'],
  `const Plugin = { define: (value) => value };
const names = ['Panel', 'Command', 'MenuItem', 'Style', 'Tabs', 'Dialog', 'SettingsPage'];
module.exports = { Plugin, usePlugin: () => ({}), ...Object.fromEntries(names.map((name) => [name, name])) };
`,
);
writeFileSync(stubs['@opencode/plugin/rpc'], 'module.exports = { Rpc: { define: (value) => value } };\n');
writeFileSync(stubs['solid-js'], 'module.exports = { createSignal: (v) => [() => v, () => {}], onMount: () => {}, createComponent: () => ({}), createEffect: () => {}, onCleanup: () => {}, Show: () => ({}), For: () => ({}) };\n');
writeFileSync(
  stubs['solid-js/web'],
  `const element = () => ({ firstChild: { firstChild: { nextSibling: {} } }, nextSibling: {} });
module.exports = { template: element, insert: () => {}, createComponent: () => ({}), delegateEvents: () => {}, effect: () => {}, setAttribute: () => {}, addEventListener: () => {} };
`,
);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, isMain, options) {
  if (stubs[request]) return stubs[request];
  return originalResolve.call(this, request, parent, isMain, options);
};

const require = createRequire(import.meta.url);
let bundle;
try {
  bundle = require(BUNDLE);
} finally {
  Module._resolveFilename = originalResolve;
}

check('the bundle exports a Plugin definition with both locales', () => {
  const definition = bundle?.default;
  if (!definition) throw new Error('no default export');
  if (typeof definition.setup !== 'function') throw new Error('no setup()');
  if (definition.i18n?.en?.title !== 'Linkr shared computer') throw new Error(`en title is ${definition.i18n?.en?.title}`);
  if (definition.i18n?.zh?.title !== 'Linkr 共享电脑') throw new Error(`zh title is ${definition.i18n?.zh?.title}`);
});

check('setup registers a side panel, command, menu item and style', () => {
  const added = [];
  const ctx = {
    id: 'opencode-linkr',
    t: (key) => key,
    add: (kind, value) => added.push({ kind, value }),
    sessions: { current: () => ({ id: 'session' }) },
    layout: { toggle: () => {} },
  };
  bundle.default.setup(ctx);
  const byKind = (kind) => added.filter((entry) => entry.kind === kind).map((entry) => entry.value);
  const styles = byKind('Style');
  if (styles.length !== 1 || !String(styles[0]).includes('.linkr-gui')) throw new Error('the panel style is missing');
  const panels = byKind('Panel');
  if (panels.length !== 1) throw new Error(`expected one panel, got ${panels.length}`);
  const panel = panels[0];
  if (panel.region !== 'side') throw new Error(`panel region is ${panel.region}`);
  if (typeof panel.list !== 'function') throw new Error('panel.list is missing');
  if (panel.list({ open: [] }).length !== 0) throw new Error('the panel lists while closed');
  const tab = panel.list({ open: ['screen'] })[0];
  if (!tab || tab.id !== 'screen') throw new Error('the panel does not list its tab');
  if (typeof panel.render !== 'function') throw new Error('panel.render is missing');
  const commands = byKind('Command').map((factory) => factory());
  if (commands.length !== 1 || commands[0].id !== 'toggle') throw new Error('the toggle command is missing');
  if (commands[0].bind !== 'ctrl+alt+l') throw new Error(`command bind is ${commands[0].bind}`);
  const items = byKind('MenuItem').map((factory) => factory());
  if (items.length !== 1 || items[0].menu !== 'session.panel') throw new Error('the session.panel menu item is missing');
});

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
