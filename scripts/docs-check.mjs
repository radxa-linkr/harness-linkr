#!/usr/bin/env node
/**
 * Docs/adapters consistency check.
 *
 * The four harness folders are hand-written companions of the shared MCP
 * server, so they drift: an action added to the tools without the AGENTS.md
 * being updated teaches the model a vocabulary the server does not have.
 * This checks the files against the code and against each other.
 *
 *   node scripts/docs-check.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../mcp-linkr/tools.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function read(relative) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) throw new Error(`missing file ${relative}`);
  return readFileSync(path, 'utf8');
}

function exists(relative) {
  return existsSync(join(ROOT, relative));
}

const SCAN_SKIP = new Set(['.git', 'build', 'node_modules', 'dist', 'coverage', '.impeccable', '.linkr']);
const SCAN_TEXT = /\.(js|mjs|cjs|json|jsonc|md|yml|yaml|html|css|svg|txt|example)$/i;

/** Every line of every source file matching `pattern`, as `path:line: text`. */
function scanSources(pattern) {
  const hits = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SCAN_SKIP.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !SCAN_TEXT.test(entry.name)) continue;
      if (relative(ROOT, full) === 'scripts/docs-check.mjs') continue; // this file defines the patterns
      readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${relative(ROOT, full)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  };
  walk(ROOT);
  return hits;
}

const computerUse = TOOLS.find((tool) => tool.name === 'linkr_computer_use');
const ACTIONS = computerUse.inputSchema.properties.action.enum;
const CORE_RULES = ['untrusted', 'capture_after', 'pixels'];
const ENV_KEYS = ['LINKR_BASE_URL', 'LINKR_USERNAME'];

const ADAPTERS = [
  { dir: 'codex', example: 'config.toml.example', harness: 'Codex' },
  { dir: 'opencode', example: 'opencode.json.example', harness: 'OpenCode' },
  { dir: 'mimocode', example: 'mimocode.jsonc.example', harness: 'MiMoCode' },
  { dir: 'minimaxcode', example: 'mcp.json.example', harness: 'MiniMaxCode' },
];

/* ---------------- repository layout ---------------- */

check('the repository AGENTS.md documents the contributor rules', () => {
  const agents = read('AGENTS.md');
  for (const needle of ['dsh-linkr/lib', 'Generated', 'npm run sync', 'npm test', 'Never leave the device changed', 'No secrets']) {
    if (!agents.includes(needle)) throw new Error(`AGENTS.md is missing "${needle}"`);
  }
  if (agents.includes('TODO') || agents.includes('TBD')) throw new Error('AGENTS.md still has placeholders');
});

check('every documented path exists', () => {
  for (const relative of [
    'README.md',
    'AGENTS.md',
    'LICENSE',
    'dsh-linkr/index.js',
    'dsh-linkr/docs/DESIGN.md',
    'core/index.js',
    'core/package.json',
    'scripts/sync-core.mjs',
    'dsh-linkr/docs/CONTRACT.md',
    'mcp-linkr/index.js',
    'mcp-linkr/README.md',
    'docs/E2E-CODEX.md',
    'docs/E2E-OPENCODE.md',
    'docs/E2E.md',
    'docs/MCP-COMPLIANCE.md',
    'scripts/setup.mjs',
    'scripts/doctor.mjs',
    'scripts/test-all.mjs',
  ]) {
    if (!exists(relative)) throw new Error(`missing ${relative}`);
  }
});

check('the root README links every adapter and the two docs', () => {
  const readme = read('README.md');
  for (const { dir } of ADAPTERS) {
    if (!readme.includes(`](${dir}/)`) && !readme.includes(`](${dir}/README.md)`)) {
      throw new Error(`root README does not link ${dir}/`);
    }
  }
  for (const doc of ['docs/E2E.md', 'docs/E2E-CODEX.md', 'docs/E2E-OPENCODE.md', 'docs/MCP-COMPLIANCE.md', 'dsh-linkr/', 'mcp-linkr/']) {
    if (!readme.includes(`](${doc})`) && !readme.includes(`](${doc}`)) throw new Error(`root README does not link ${doc}`);
  }
});

check('no stale path references remain', () => {
  const files = [
    'README.md',
    'codex/README.md',
    'opencode/README.md',
    'mimocode/README.md',
    'minimaxcode/README.md',
    'mcp-linkr/README.md',
    'dsh-linkr/README.md',
  ];
  for (const file of files) {
    if (read(file).includes('integrations/dsh-linkr')) {
      throw new Error(`${file} still points at the old package path`);
    }
  }
});

/* ---------------- per adapter ---------------- */

for (const { dir, example, harness } of ADAPTERS) {
  check(`${harness}: folder has README, AGENTS.md and a config example`, () => {
    for (const file of ['README.md', 'AGENTS.md', example]) {
      if (!exists(join(dir, file))) throw new Error(`missing ${dir}/${file}`);
    }
  });

  check(`${harness}: AGENTS.md teaches every action`, () => {
    const agents = read(join(dir, 'AGENTS.md'));
    const missing = ACTIONS.filter((action) => !agents.includes(action));
    if (missing.length > 0) throw new Error(`AGENTS.md does not mention ${missing.join(', ')}`);
  });

  check(`${harness}: AGENTS.md carries the safety rules`, () => {
    const agents = read(join(dir, 'AGENTS.md')).toLowerCase();
    const missing = CORE_RULES.filter((rule) => !agents.includes(rule));
    if (missing.length > 0) throw new Error(`AGENTS.md does not mention ${missing.join(', ')}`);
  });

  check(`${harness}: README explains install and the shared server`, () => {
    const readme = read(join(dir, 'README.md'));
    for (const needle of ['mcp-linkr/index.js', 'LINKR_BASE_URL', 'setup.mjs', '../mcp-linkr/']) {
      if (!readme.includes(needle)) throw new Error(`README is missing "${needle}"`);
    }
  });

  check(`${harness}: config example is a real entry for this server`, () => {
    const config = read(join(dir, example));
    for (const needle of ['mcp-linkr/index.js', ...ENV_KEYS]) {
      if (!config.includes(needle)) throw new Error(`${example} is missing "${needle}"`);
    }
    // The password may be inline or referenced from a file; one of them must be shown.
    if (!config.includes('LINKR_PASSWORD')) throw new Error(`${example} does not show how to supply the password`);
  });
}

// Remove line and block comments without touching strings (URLs contain slashes).
function stripJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function jsonExample(relative, { jsonc = false } = {}) {
  const text = read(relative);
  const source = jsonc ? stripJsonc(text) : text;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${relative} is not valid ${jsonc ? 'JSONC' : 'JSON'}: ${error.message}`);
  }
}

/* ---------------- config example structure ---------------- */

check('codex/config.toml.example has the expected TOML entry', () => {
  const toml = read('codex/config.toml.example');
  for (const needle of ['[mcp_servers.linkr]', 'command = "node"', 'args = [', '[mcp_servers.linkr.env]', 'LINKR_BASE_URL']) {
    if (!toml.includes(needle)) throw new Error(`missing "${needle}"`);
  }
});

check('opencode/opencode.json.example parses and points at the server (2.x shape)', () => {
  const config = jsonExample('opencode/opencode.json.example');
  const entry = config?.mcp?.servers?.linkr;
  if (!entry) throw new Error('no mcp.servers.linkr entry (OpenCode 2.x shape)');
  if (config.mcp?.linkr) throw new Error('a flat mcp.linkr entry is the 1.x shape and invisible to OpenCode 2');
  if (entry.type !== 'local') throw new Error(`type is ${entry.type}`);
  if (!Array.isArray(entry.command) || !entry.command.join(' ').includes('mcp-linkr/index.js')) throw new Error('command does not launch mcp-linkr/index.js');
  for (const key of ['LINKR_BASE_URL', 'LINKR_USERNAME']) if (!entry.environment?.[key]) throw new Error(`environment.${key} missing`);
  if (entry.enabled !== undefined) throw new Error('OpenCode 2 uses `disabled`, not `enabled`');
});

check('opencode native plugin package is complete', () => {
  const pkg = JSON.parse(read('opencode/plugin/package.json'));
  if (pkg.name !== 'opencode-linkr') throw new Error(`unexpected name ${pkg.name}`);
  if (!String(pkg.engines?.opencode ?? '').includes('2.')) throw new Error('engines.opencode must require OpenCode 2');
  if (!Array.isArray(pkg.files) || !pkg.files.includes('index.js')) throw new Error('files must ship index.js');
  if (pkg.dependencies?.['@opencode/plugin'] === undefined) throw new Error('@opencode/plugin dependency missing');
  const index = read('opencode/plugin/index.js');
  if (!index.includes('Plugin.define')) throw new Error('index.js does not define a Plugin');
  for (const tool of ['linkr_status', 'linkr_computer_use', 'linkr_panel']) if (!index.includes(tool)) throw new Error(`index.js does not register ${tool}`);
  for (const file of ['panel-server.js', 'panel/index.html', 'panel/panel.js', 'panel/panel.css']) if (!exists(`opencode/plugin/${file}`)) throw new Error(`opencode/plugin/${file} is missing`);
  if (!Array.isArray(pkg.files) || !pkg.files.includes('panel-server.js')) throw new Error('files must ship panel-server.js');
  if (pkg.exports?.['./gui-experimental'] !== './dist/gui-experimental.cjs') throw new Error('package.json must export ./gui-experimental');
  if (!Array.isArray(pkg.files) || !pkg.files.includes('dist')) throw new Error('files must ship dist/');
  for (const file of ['vite.config.mjs', 'gui/index.jsx', 'gui/panel.jsx', 'gui/rpc-schema.js', 'dist/gui-experimental.cjs']) {
    if (!exists(`opencode/plugin/${file}`)) throw new Error(`opencode/plugin/${file} is missing`);
  }
  const bundle = read('opencode/plugin/dist/gui-experimental.cjs');
  for (const external of ['@opencode/plugin/gui', '@opencode/plugin/rpc', 'solid-js']) {
    if (!bundle.includes(`require("${external}")`)) throw new Error(`the GUI bundle should keep ${external} external`);
  }
  if (!exists('opencode/plugin/README.md')) throw new Error('opencode/plugin/README.md is missing');
  if (!exists('opencode/plugin/LICENSE')) throw new Error('opencode/plugin/LICENSE is missing');
});

check('mimocode/mimocode.jsonc.example parses as JSONC and points at the server', () => {
  const config = jsonExample('mimocode/mimocode.jsonc.example', { jsonc: true });
  const entry = config?.mcp?.linkr;
  if (!entry) throw new Error('no mcp.linkr entry');
  if (entry.type !== 'local') throw new Error(`type is ${entry.type}`);
  if (!Array.isArray(entry.command) || !entry.command.join(' ').includes('mcp-linkr/index.js')) throw new Error('command does not launch mcp-linkr/index.js');
});

check('minimaxcode/mcp.json.example parses with the mcpServers shape', () => {
  const config = jsonExample('minimaxcode/mcp.json.example');
  const entry = config?.mcpServers?.linkr;
  if (!entry) throw new Error('no mcpServers.linkr entry');
  if (entry.type !== 'stdio') throw new Error(`type is ${entry.type}`);
  if (typeof entry.command !== 'string') throw new Error('command should be a string');
  if (!Array.isArray(entry.args) || !entry.args.join(' ').includes('mcp-linkr/index.js')) throw new Error('args do not launch mcp-linkr/index.js');
});

check('docs/E2E.md links every adapter README', () => {
  const status = read('docs/E2E.md');
  for (const relative of ['codex/README.md', 'opencode/README.md', 'mimocode/README.md', 'minimaxcode/README.md']) {
    if (!status.includes(`../${relative}`)) throw new Error(`E2E.md does not link ${relative}`);
  }
});

/* ---------------- dsh side ---------------- */

check('dsh-linkr README documents its three tools and links its docs', () => {
  const readme = read('dsh-linkr/README.md');
  for (const needle of ['linkr_computer_use', 'linkr_status', 'linkr_panel', 'docs/DESIGN.md', 'docs/CONTRACT.md']) {
    if (!readme.includes(needle)) throw new Error(`dsh-linkr README is missing "${needle}"`);
  }
});

check('no references to the device web-console sources', () => {
  // The protocol is documented as observed device behaviour; its implementation
  // lives elsewhere and must not be named or linked here. The pattern is built
  // from parts so this guard file itself carries no such literal.
  const KVM_WEB_SOURCE = new RegExp(['kvm', 'web'].join('') + '|' + ['kvm', '[ -]?', 'web'].join(''), 'i');
  const hits = scanSources(KVM_WEB_SOURCE);
  if (hits.length > 0) throw new Error(`a reference to the device web-console sources is not allowed:\n${hits.slice(0, 5).join('\n')}`);
});

check('no personal device values in the sources', () => {
  const PERSONAL_VALUES = new RegExp([
    ['192', '168', '8', '171'].join('\\.'),
    ['xiang', 'zelong'].join(''),
    ['b0e3b3a9', 'ce5397d5'].join(''),
    ['\\bx', 'zl\\b'].join(''),
    ['/Volu', 'mes/', 'extend'].join(''),
  ].join('|'), 'i');
  const hits = scanSources(PERSONAL_VALUES);
  if (hits.length > 0) throw new Error(`personal/device-specific values are not allowed:\n${hits.slice(0, 5).join('\n')}`);
});

check('the transport source lives in core/ and the plugin ships a materialized copy', () => {
  const core = readdirSync(join(ROOT, 'core')).filter((name) => name.endsWith('.js')).sort();
  for (const name of ['index.js', 'client.js', 'control.js', 'ffmpeg.js', 'hid.js', 'linkr.js', 'media.js']) {
    if (!core.includes(name)) throw new Error(`core/${name} is missing`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'dsh-linkr', 'package.json'), 'utf8'));
  if (!Array.isArray(pkg.files) || !pkg.files.includes('lib')) throw new Error('dsh-linkr package.json does not ship lib/');
  const lib = readdirSync(join(ROOT, 'dsh-linkr', 'lib')).filter((name) => name.endsWith('.js')).sort();
  if (lib.join(',') !== core.join(',')) throw new Error(`dsh-linkr/lib is stale: [${lib.join(',')}] vs core [${core.join(',')}]`);
});

check('the dsh tool files are the modular host/ layout', () => {
  for (const relative of ['dsh-linkr/host/config.js', 'dsh-linkr/host/tools.js', 'dsh-linkr/host/routes.js', 'dsh-linkr/host/client.js', 'dsh-linkr/host/activity.js']) {
    if (!exists(relative)) throw new Error(`missing ${relative}`);
    if (statSync(join(ROOT, relative)).size < 100) throw new Error(`${relative} looks empty`);
  }
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
