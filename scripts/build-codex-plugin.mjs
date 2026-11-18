#!/usr/bin/env node
/** Build a self-contained local plugin, without symlinks or embedded credentials. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// dsh-linkr/lib is materialized from core/ (see scripts/sync-core.mjs); a fresh
// clone has no lib/, so build it from the source of truth first.
execFileSync(process.execPath, [join(root, 'scripts', 'sync-core.mjs')], { stdio: 'inherit' });
const target = join(root, 'build', 'codex-linkr');
const manifest = JSON.parse(await readFile(join(root, 'codex/plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(root, 'codex/mcp.json'), 'utf8'));
await rm(target, { recursive: true, force: true });
await mkdir(join(target, 'runtime/mcp-linkr'), { recursive: true });
await mkdir(join(target, 'runtime/dsh-linkr'), { recursive: true });
for (const name of ['plugin.json', 'mcp.json', 'README.md', 'skills']) await cp(join(root, 'codex', name), join(target, name), { recursive: true });
for (const name of ['index.js', 'tools.js', 'config.js', 'settings.js', 'device-mode.js', 'device-lease.js', 'panel.js', 'panel']) {
  await cp(join(root, 'mcp-linkr', name), join(target, 'runtime/mcp-linkr', name), { recursive: true });
}
await cp(join(root, 'dsh-linkr/lib'), join(target, 'runtime/dsh-linkr/lib'), { recursive: true });
await mkdir(join(target, 'assets'), { recursive: true });
await cp(join(root, 'dsh-linkr/icon.svg'), join(target, 'assets/icon.svg'));
await cp(join(root, 'LICENSE'), join(target, 'LICENSE'));
await writeFile(join(target, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: 'module', engines: { node: '>=22' } }, null, 2) + '\n');
// Compatibility for local clients that still discover .codex-plugin manifests.
await mkdir(join(target, '.codex-plugin'), { recursive: true });
await writeFile(join(target, '.codex-plugin/plugin.json'), JSON.stringify({ name: manifest.name, version: manifest.version, description: manifest.description,
  skills: './skills', mcpServers: './.mcp.json', requires_local_executor: true, interface: manifest.extensions['com.openai'].interface }, null, 2) + '\n');
await writeFile(join(target, '.mcp.json'), JSON.stringify({ mcpServers: JSON.parse(JSON.stringify(mcp.mcpServers).replaceAll('${PLUGIN_ROOT}', '${CODEX_PLUGIN_ROOT}')) }, null, 2) + '\n');
const catalogDir = join(root, 'build/.agents/plugins');
await mkdir(catalogDir, { recursive: true });
await writeFile(join(catalogDir, 'marketplace.json'), JSON.stringify({ name: 'linkr-local', interface: { displayName: 'Linkr 本地插件' },
  plugins: [{ name: manifest.name, source: { source: 'local', path: './codex-linkr' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity', interface: { displayName: 'Linkr' } }] }, null, 2) + '\n');
console.log(`Built ${manifest.name} ${manifest.version}: ${target}`);
