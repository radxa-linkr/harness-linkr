#!/usr/bin/env node
/**
 * Packaging smoke test: prove that a packed `dsh-linkr` tarball is
 * self-contained.
 *
 * This is the point of `core/`: the source lives one directory up, but a tarball
 * that someone installs has to carry the transport inside the package. The test
 * materializes core/ (via sync-core), runs `npm pack`, extracts the tarball into
 * a throwaway directory outside the repository, and imports the packaged entry
 * point from there. A relative `../core` reference would fail this test, which
 * is exactly the regression it exists to catch.
 *
 *   node scripts/pack-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = join(ROOT, 'dsh-linkr');
const scratch = mkdtempSync(join(tmpdir(), 'linkr-pack-smoke-'));

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

function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolveRun({ ok: false, stdout, stderr: `${stderr}${error.message}` }));
    child.on('exit', (code) => resolveRun({ ok: code === 0, code: code ?? 0, stdout, stderr }));
  });
}

async function main() {
  const sync = await run(process.execPath, [join(ROOT, 'scripts', 'sync-core.mjs')]);
  if (!sync.ok) {
    console.log(`FAIL  sync-core runs\n      ${sync.stderr.trim() || sync.stdout.trim()}`);
    process.exit(1);
  }

  const packs = join(scratch, 'packs');
  const unpacked = join(scratch, 'unpacked');
  const mkdir = await run('/bin/mkdir', ['-p', packs, unpacked]);
  if (!mkdir.ok) throw new Error(`mkdir failed: ${mkdir.stderr}`);

  const pack = await run('npm', ['pack', '--pack-destination', packs, '--json', '--silent'], { cwd: PACKAGE_DIR });
  check('npm pack succeeds', () => {
    if (!pack.ok) throw new Error(pack.stderr.trim() || 'npm pack failed');
  });
  let tarball = '';
  try {
    const parsed = JSON.parse(pack.stdout);
    // npm >= 11 prints an object keyed by package name; older versions print an array.
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    tarball = join(packs, entry.filename);
  } catch {
    tarball = '';
  }
  check('npm pack produced a tarball', () => {
    if (tarball === '') throw new Error(`could not read npm pack output: ${pack.stdout.slice(0, 200)}`);
  });
  if (tarball === '') {
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  }

  const untar = await run('tar', ['-xzf', tarball, '-C', unpacked]);
  check('tarball extracts', () => {
    if (!untar.ok) throw new Error(untar.stderr.trim());
  });

  const packageRoot = join(unpacked, 'package');
  const core = readdirSync(join(ROOT, 'core')).filter((name) => name.endsWith('.js')).sort();
  const shipped = readdirSync(join(packageRoot, 'lib')).filter((name) => name.endsWith('.js')).sort();
  check('the tarball carries every transport module', () => {
    if (shipped.join(',') !== core.join(',')) throw new Error(`shipped [${shipped.join(',')}] vs core [${core.join(',')}]`);
  });

  check('the packaged transport is byte-identical to core/', () => {
    for (const name of core) {
      const a = readFileSync(join(ROOT, 'core', name));
      const b = readFileSync(join(packageRoot, 'lib', name));
      if (!a.equals(b)) throw new Error(`${name} differs from core/`);
    }
  });

  check('the tarball does not reference paths outside the package', () => {
    for (const name of ['index.js', 'host/client.js', 'host/config.js', 'host/tools.js', 'host/routes.js', 'host/activity.js', 'lib/index.js']) {
      const text = readFileSync(join(packageRoot, name), 'utf8');
      for (const bad of ["from '../core", 'from "../../core', "from '../dsh-linkr", 'from "../../dsh-linkr']) {
        if (text.includes(bad)) throw new Error(`${name} still references ${bad}`);
      }
    }
  });

  // Import the packaged plugin entry from outside the repository. `apply` must
  // exist and `Config` must be a standard-schema face; no device is touched.
  const probe = join(scratch, 'probe.mjs');
  writeFileSync(
    probe,
    `const mod = await import(${JSON.stringify(join(packageRoot, 'index.js'))});\n` +
      `if (typeof mod.apply !== 'function') throw new Error('apply is missing');\n` +
      `if (mod.name !== 'linkr') throw new Error('unexpected plugin name ' + mod.name);\n` +
      `if (!mod.Config || mod.Config['~standard'] === undefined) throw new Error('Config face is missing');\n` +
      `const transport = await import(${JSON.stringify(join(packageRoot, 'lib', 'index.js'))});\n` +
      `if (typeof transport.LinkrClient !== 'function') throw new Error('LinkrClient is missing from the packaged lib');\n` +
      `console.log('packaged entry exports', mod.name, 'and LinkrClient');\n`,
  );
  const importRun = await run(process.execPath, [probe]);
  check('the packaged entry imports from outside the repository', () => {
    if (!importRun.ok) throw new Error(importRun.stderr.trim() || importRun.stdout.trim());
  });

  rmSync(scratch, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  rmSync(scratch, { recursive: true, force: true });
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
