#!/usr/bin/env node
/**
 * Materialize the shared transport into the package that ships it.
 *
 * `core/` is the single source of truth. A packaged plugin must not reference
 * anything outside its own package (a tarball or a copied directory loses
 * siblings), so the transport is copied into `dsh-linkr/lib/` at build time and
 * that directory is gitignored. The MCP bundle script copies that materialized
 * directory into its runtime (see scripts/build-codex-plugin.mjs).
 *
 *   node scripts/sync-core.mjs           write dsh-linkr/lib/ from core/
 *   node scripts/sync-core.mjs --check   verify the copy is exactly up to date
 */

import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'core');
const TARGET = join(ROOT, 'dsh-linkr', 'lib');
const CHECK = process.argv.includes('--check');

const isModule = (name) => name.endsWith('.js');

async function modules(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && isModule(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function main() {
  const source = await modules(SOURCE);
  const target = await modules(TARGET);

  if (CHECK) {
    const problems = [];
    const missing = source.filter((name) => !target.includes(name));
    const extra = target.filter((name) => !source.includes(name));
    if (missing.length > 0) problems.push(`missing in dsh-linkr/lib: ${missing.join(', ')}`);
    if (extra.length > 0) problems.push(`stale in dsh-linkr/lib: ${extra.join(', ')}`);
    for (const name of source) {
      if (!target.includes(name)) continue;
      const [a, b] = await Promise.all([readFile(join(SOURCE, name)), readFile(join(TARGET, name))]);
      if (!a.equals(b)) problems.push(`out of date: ${name}`);
    }
    if (problems.length > 0) {
      console.error(`sync-core --check: ${problems.join('; ')}`);
      console.error('run `node scripts/sync-core.mjs` to materialize core/ into dsh-linkr/lib/');
      process.exit(1);
    }
    console.log(`sync-core --check: dsh-linkr/lib matches core/ (${source.length} modules)`);
    return;
  }

  await rm(TARGET, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });
  for (const name of source) await cp(join(SOURCE, name), join(TARGET, name));
  console.log(`sync-core: wrote ${source.length} modules from core/ to dsh-linkr/lib/`);
}

main().catch((error) => {
  console.error(`sync-core: ${error.message}`);
  process.exit(1);
});
