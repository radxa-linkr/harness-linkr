#!/usr/bin/env node
/**
 * Verify `scripts/setup.mjs` without touching the user's real harness configs.
 *
 * Everything runs with HOME / CODEX_HOME / XDG_CONFIG_HOME / MIMOCODE_CONFIG_DIR /
 * MINIMAX_DATA_DIR pointed at a throwaway directory, so the real machine's
 * configuration is never read or written.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'scripts', 'setup.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'harness-linkr-setup-'));
const home = join(scratch, 'home');
const project = join(scratch, 'project');
const env = {
  HOME: home,
  CODEX_HOME: join(scratch, 'codex'),
  XDG_CONFIG_HOME: join(scratch, 'xdg'),
  MIMOCODE_CONFIG_DIR: join(scratch, 'mimo'),
  MINIMAX_DATA_DIR: join(scratch, 'minimax'),
};
const passwordFile = join(scratch, 'device-password');
writeFileSync(passwordFile, 'smoke-test-password\n', { mode: 0o600 });
for (const dir of [home, project, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.MIMOCODE_CONFIG_DIR, env.MINIMAX_DATA_DIR]) {
  mkdirSync(dir, { recursive: true });
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, ...env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function commandAvailable(name) {
  return run(name, ['--version']).then((result) => result.code === 0);
}

async function main() {
  await check('dry run writes nothing and reports all four harnesses', async () => {
    const result = await run(process.execPath, [
      SETUP,
      '--harness', 'all',
      '--base-url', 'http://linkr.local',
      '--username', 'tester',
      '--password-file', passwordFile,
      '--project', project,
      '--dry-run',
      '--json',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results.length, 4);
    assert.deepEqual(report.results.map((entry) => entry.harness).sort(), ['codex', 'minimaxcode', 'mimocode', 'opencode'].sort());
    assert.ok(report.results.every((entry) => entry.applied === false));
    assert.deepEqual(readdirSync(project), []);
  });

  await check('real setup writes valid configs for every harness', async () => {
    const result = await run(process.execPath, [
      SETUP,
      '--harness', 'all',
      '--base-url', 'http://linkr.local',
      '--username', 'tester',
      '--password-file', passwordFile,
      '--project', project,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const server = join(ROOT, 'mcp-linkr', 'index.js');

    const codexConfig = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(codexConfig, /\[mcp_servers\.linkr\]/);
    assert.ok(codexConfig.includes(server));
    assert.match(codexConfig, /LINKR_BASE_URL = "http:\/\/linkr\.local"/);

    const opencode = readJson(join(project, 'opencode.json'));
    // OpenCode 2 moves servers under mcp.servers; 1.x keeps them under mcp.
    const opencodeEntry = opencode.mcp?.servers?.linkr ?? opencode.mcp?.linkr;
    assert.ok(opencodeEntry, 'no linkr entry under mcp.servers.linkr or mcp.linkr');
    assert.equal(opencodeEntry.type, 'local');
    assert.deepEqual(opencodeEntry.command, [process.execPath, server]);
    assert.equal(opencodeEntry.environment.LINKR_USERNAME, 'tester');
    if (opencode.mcp?.servers?.linkr) assert.notEqual(opencodeEntry.disabled, true, 'the 2.x entry must not be disabled');
    else assert.equal(opencodeEntry.enabled, true);

    const mio = readJson(join(project, 'mimocode.json'));
    assert.deepEqual(mio.mcp.linkr.command, [process.execPath, server]);

    const minimax = readJson(join(project, '.mcp.json'));
    assert.equal(minimax.mcpServers.linkr.type, 'stdio');
    assert.deepEqual(minimax.mcpServers.linkr.args, [server]);
    assert.equal(minimax.mcpServers.linkr.env.LINKR_BASE_URL, 'http://linkr.local');
  });

  await check('re-running is idempotent and keeps one entry', async () => {
    const again = await run(process.execPath, [
      SETUP,
      '--harness', 'all',
      '--username', 'tester',
      '--password-file', passwordFile,
      '--project', project,
    ]);
    assert.equal(again.code, 0, again.stderr);
    const codexConfig = readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.equal(codexConfig.match(/\[mcp_servers\.linkr\]/g).length, 1);
    const opencode = readJson(join(project, 'opencode.json'));
    const opencodeEntries = [opencode.mcp?.servers?.linkr, opencode.mcp?.linkr].filter(Boolean);
    assert.equal(opencodeEntries.length, 1, `expected one linkr entry, got ${opencodeEntries.length}`);
    assert.ok(!(opencode.mcp?.servers?.linkr && opencode.mcp?.linkr), '1.x and 2.x entries must not coexist');
    assert.ok(readdirSync(project).some((file) => file.includes('.bak-')), 'no backup was kept');
  });

  await check('MiniMaxCode without --project writes its user-level mcp.json', async () => {
    const result = await run(process.execPath, [
      SETUP,
      '--harness', 'minimaxcode',
      '--username', 'tester',
      '--password-file', passwordFile,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const userLevel = readJson(join(env.MINIMAX_DATA_DIR, 'mcp.json'));
    assert.equal(userLevel.mcpServers.linkr.type, 'stdio');
    assert.equal(userLevel.mcpServers.linkr.env.LINKR_USERNAME, 'tester');
  });

  await check('Codex update preserves disabled tools and keeps an exact configuration backup', async () => {
    const path = join(env.CODEX_HOME, 'config.toml');
    const before = readFileSync(path, 'utf8').replace('[mcp_servers.linkr]', '[mcp_servers.linkr]\nenabled = false\ndisabled_tools = ["linkr_computer_use"]\nstartup_timeout_sec = 45');
    writeFileSync(path, before);
    const result = await run(process.execPath, [SETUP, '--harness', 'codex', '--username', 'tester', '--password-file', passwordFile, '--json']);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(readFileSync(report.results[0].backup, 'utf8'), before);
    const current = await run('codex', ['mcp', 'get', 'linkr', '--json']);
    const entry = JSON.parse(current.stdout);
    assert.equal(entry.enabled, false);
    assert.deepEqual(entry.disabled_tools, ['linkr_computer_use']);
    assert.equal(entry.startup_timeout_sec, 45);
    writeFileSync(path, before.replace('enabled = false', 'enabled = true'));
  });

  await check('Codex password forwarding example parses with env_vars on the server table', async () => {
    const path = join(env.CODEX_HOME, 'config.toml');
    const previous = readFileSync(path, 'utf8');
    const sample = readFileSync(join(ROOT, 'codex/config.toml.example'), 'utf8').replace('# env_vars = ["LINKR_PASSWORD"]', 'env_vars = ["LINKR_PASSWORD"]').replace(/^LINKR_PASSWORD = .*\n/m, '');
    try {
      writeFileSync(path, sample);
      const parsed = await run('codex', ['mcp', 'get', 'linkr', '--json']);
      assert.equal(parsed.code, 0, parsed.stderr);
      assert.deepEqual(JSON.parse(parsed.stdout).transport.env_vars, ['LINKR_PASSWORD']);
    } finally { writeFileSync(path, previous); }
  });

  await check('the password file is never copied into a config', async () => {
    const password = readFileSync(passwordFile, 'utf8').trim();
    for (const path of [
      join(env.CODEX_HOME, 'config.toml'),
      join(project, 'opencode.json'),
      join(project, 'mimocode.json'),
      join(project, '.mcp.json'),
    ]) {
      const text = readFileSync(path, 'utf8');
      assert.ok(!text.includes(password), `${path} contains the password`);
      assert.ok(text.includes(passwordFile), `${path} does not reference the password file`);
    }
  });

  for (const harness of [
    { name: 'codex', args: ['mcp', 'list'], expect: /linkr/ },
    { name: 'mimo', args: ['mcp', 'list'], expect: /linkr/, cwd: project },
  ]) {
    const available = await commandAvailable(harness.name);
    await check(`${harness.name}: mcp list sees the server`, async () => {
      if (!available) {
        console.log(`      (skipped: ${harness.name} is not installed)`);
        return;
      }
      const result = await run(harness.name, harness.args, { cwd: harness.cwd ?? ROOT, env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } });
      const text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      // A desktop build of the harness can own the same managed socket the CLI
      // wants; the config written by setup.mjs is still correct (asserted above),
      // so an environment collision is reported as skipped, not as a failure.
      if (/Managed service port|already in use by PID/i.test(text)) {
        console.log(`      (skipped: ${harness.name} CLI cannot start while its desktop service is running)`);
        return;
      }
      assert.match(text, harness.expect, `${harness.name} mcp list did not mention linkr:\n${text.slice(0, 400)}`);
    });
  }

  await check('opencode: the configured server is visible to the CLI', async () => {
    if (!(await commandAvailable('opencode'))) {
      console.log('      (skipped: opencode is not installed)');
      return;
    }
    const version = await run('opencode', ['--version'], { cwd: project, env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } });
    const major = Number((/(\d+)\.\d+/.exec(`${version.stdout}\n${version.stderr}`) ?? [])[1] ?? 0);
    if (major >= 2) {
      // 2.x `mcp list` does not report project servers; `debug config` prints
      // the resolved config, which is the same thing the agent will load.
      const result = await run('opencode', ['--standalone', 'debug', 'config'], { cwd: project, env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } });
      const text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
      if (/Managed service port|already in use by PID/i.test(text)) {
        console.log('      (skipped: OpenCode desktop service owns the CLI socket)');
        return;
      }
      assert.match(text, /"linkr"/, `opencode 2.x did not load the linkr server:\n${text.slice(0, 400)}`);
      return;
    }
    const result = await run('opencode', ['mcp', 'list'], { cwd: project, env: { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } });
    const text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(text, /linkr/, `opencode 1.x mcp list did not mention linkr:\n${text.slice(0, 400)}`);
  });

  await check('a missing password source fails with a clear message', async () => {
    const clean = await run(process.execPath, [SETUP, '--harness', 'opencode', '--username', 'tester', '--project', project], {
      env: { HOME: join(scratch, 'empty-home') },
    });
    assert.notEqual(clean.code, 0);
    assert.match(clean.stderr, /no device password/);
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
