#!/usr/bin/env node
/**
 * One-command setup for the Linkr MCP server in a harness.
 *
 *   node scripts/setup.mjs --harness codex|opencode|mimocode|minimaxcode|all
 *                          [--base-url http://linkr.local] [--username admin]
 *                          [--password-file ~/.linkr/password] [--project <dir>]
 *                          [--dry-run] [--json]
 *
 * It writes the harness's own configuration (never a private copy of the
 * server), pointing it at `mcp-linkr/index.js` in this repository, and keeps a
 * backup of every file it modifies.
 *
 * The password is never printed. Sources, in order:
 *   --password-file <path>            referenced as LINKR_PASSWORD_FILE
 *   LINKR_PASSWORD                    written to ~/.linkr/password (0600) and referenced
 *   an existing ~/.linkr/password     reused
 */

import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateCodexConfig } from './codex-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp-linkr', 'index.js');
const HARNESSES = ['codex', 'opencode', 'mimocode', 'minimaxcode'];

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const args = {
    harness: '',
    baseUrl: 'http://linkr.local',
    username: '',
    passwordFile: '',
    project: '',
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    switch (arg) {
      case '--harness':
        args.harness = next();
        break;
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--username':
        args.username = next();
        break;
      case '--password-file':
        args.passwordFile = next();
        break;
      case '--project':
        args.project = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (args.harness !== '' && args.harness !== 'all' && !HARNESSES.includes(args.harness)) {
    throw new Error(`--harness must be one of ${HARNESSES.join(', ')}, or all`);
  }
  return args;
}

function usage() {
  return [
    'Set up the Linkr MCP server in an agent harness.',
    '',
    'Usage: node scripts/setup.mjs --harness <codex|opencode|mimocode|minimaxcode|all> [options]',
    '',
    'Options:',
    '  --base-url <url>        Linkr device origin (default http://linkr.local)',
    '  --username <name>       device account',
    '  --password-file <path>  file containing the device password (one line)',
    '  --project <dir>         project-scoped config (opencode.json / mimocode.json / .mcp.json);',
    '                          defaults to cwd for OpenCode/MiMo, and to the user-level file for MiniMaxCode',
    '  --dry-run               print what would be written, change nothing',
    '  --json                  machine-readable result on stdout',
    '  -h, --help              this help',
    '',
    'The password itself never reaches stdout: pass --password-file, or put it in',
    'LINKR_PASSWORD for this command (it is then saved once to ~/.linkr/password, 0600).',
    '',
  ].join('\n');
}

/* ---------------- helpers ---------------- */

const expand = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Atomic write that keeps a backup of the previous file. */
async function writeConfig(path, content) {
  await mkdir(dirname(path), { recursive: true });
  let backup = '';
  try {
    const info = await stat(path);
    if (info.isFile()) {
      backup = `${path}.bak-${stamp()}`;
      await copyFile(path, backup);
    }
  } catch {
    /* no previous file */
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  return { path, backup };
}

async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { exists: true, value: JSON.parse(text) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, value: null };
    if (error instanceof SyntaxError) {
      return { exists: true, invalid: true, value: null, error };
    }
    throw error;
  }
}

function commandExists(command, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => resolvePromise(false));
    child.on('exit', (code) => resolvePromise(code === 0));
  });
}

async function run(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => resolvePromise({ ok: false, stdout, stderr: `${stderr}${error.message}` }));
    child.on('exit', (code) => resolvePromise({ ok: code === 0, stdout, stderr }));
  });
}

/* ---------------- password ---------------- */

async function resolvePassword(args) {
  if (args.passwordFile !== '') {
    const path = resolve(expand(args.passwordFile));
    try {
      await stat(path);
    } catch {
      throw new Error(`--password-file ${path} does not exist`);
    }
    return { file: path, created: false };
  }
  const stored = join(homedir(), '.linkr', 'password');
  if (process.env.LINKR_PASSWORD) {
    if (!args.dryRun) {
      await mkdir(dirname(stored), { recursive: true, mode: 0o700 });
      await writeFile(stored, `${process.env.LINKR_PASSWORD}\n`, { mode: 0o600 });
      await chmod(stored, 0o600);
    }
    return { file: stored, created: !args.dryRun };
  }
  try {
    await stat(stored);
    return { file: stored, created: false };
  } catch {
    throw new Error(
      'no device password: pass --password-file <path>, or set LINKR_PASSWORD for this command ' +
        '(it is saved to ~/.linkr/password with mode 0600)',
    );
  }
}

/** The environment every harness entry needs. */
function entryEnvironment(args, password) {
  return {
    LINKR_BASE_URL: args.baseUrl,
    LINKR_USERNAME: args.username,
    LINKR_PASSWORD_FILE: password.file,
  };
}

/* ---------------- writers ---------------- */

async function setupCodex(args, env, password) {
  const commandExistsCodex = await commandExists('codex', ['--version']);
  if (!commandExistsCodex) {
    return {
      harness: 'codex',
      action: 'manual',
      applied: false,
      reason: 'codex is not on PATH; append codex/config.toml.example to ~/.codex/config.toml',
    };
  }
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const path = join(codexHome, 'config.toml');
  const source = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const existing = await run('codex', ['mcp', 'get', 'linkr', '--json']);
  const previous = existing.ok ? JSON.parse(existing.stdout) : null;
  const content = updateCodexConfig(source, { command: process.execPath, server: SERVER, environment: env, previous });
  if (args.dryRun) return { harness: 'codex', action: 'write', applied: false, configFile: path, preview: content };
  // Validate with Codex itself before touching the real file. Never copy auth.
  const scratch = await mkdtemp(join(tmpdir(), 'linkr-codex-config-'));
  try {
    await writeFile(join(scratch, 'config.toml'), content, { mode: 0o600 });
    const valid = await run('codex', ['mcp', 'get', 'linkr', '--json'], { CODEX_HOME: scratch });
    if (!valid.ok) throw new Error(`Codex rejected the proposed configuration: ${valid.stderr.trim().slice(0, 300)}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const written = await writeConfig(path, content);
  return { harness: 'codex', action: 'write', applied: true, configFile: path, backup: written.backup };
}

async function setupOpencode(args, env) {
  const project = resolve(args.project || process.cwd());
  const path = join(project, 'opencode.json');
  const current = await readJson(path);
  if (current.invalid) {
    throw new Error(`${path} is not strict JSON (OpenCode also accepts JSONC); edit mcp.linkr by hand from opencode/opencode.json.example`);
  }
  const next = current.value ?? { $schema: 'https://opencode.ai/config.json' };
  const mcp = { ...(next.mcp ?? {}) };
  mcp.linkr = { type: 'local', command: [process.execPath, SERVER], environment: env, enabled: true };
  next.mcp = mcp;
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (args.dryRun) return { harness: 'opencode', action: 'write', applied: false, configFile: path, preview: content };
  const written = await writeConfig(path, content);
  return { harness: 'opencode', action: 'write', applied: true, configFile: written.path, backup: written.backup };
}

async function setupMimocode(args, env) {
  const project = resolve(args.project || process.cwd());
  // mimo reads mimo.jsonc/mimo.json in the project; write strict JSON so a
  // hand-edited JSONC file is never rewritten by us.
  const path = join(project, 'mimocode.json');
  const current = await readJson(path);
  if (current.invalid) {
    throw new Error(`${path} is not strict JSON; edit mcp.linkr by hand from mimocode/mimocode.jsonc.example`);
  }
  const next = current.value ?? { $schema: 'https://mimo.xiaomi.com/mimocode/config.json' };
  const mcp = { ...(next.mcp ?? {}) };
  mcp.linkr = { type: 'local', command: [process.execPath, SERVER], environment: env, enabled: true };
  next.mcp = mcp;
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (args.dryRun) return { harness: 'mimocode', action: 'write', applied: false, configFile: path, preview: content };
  const written = await writeConfig(path, content);
  return { harness: 'mimocode', action: 'write', applied: true, configFile: written.path, backup: written.backup };
}

async function setupMinimaxcode(args, env) {
  // MiniMaxCode reads project `.mcp.json` (same `mcpServers` shape) and the
  // user-level file under its data directory. A project file wins when the
  // caller passes --project; without one we write the user-level file.
  const useProject = args.project !== '';
  const path = useProject
    ? join(resolve(args.project), '.mcp.json')
    : join(process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax'), 'mcp.json');
  const current = await readJson(path);
  if (current.invalid) throw new Error(`${path} is not strict JSON; merge minimaxcode/mcp.json.example by hand`);
  const next = current.value ?? {};
  const servers = { ...(next.mcpServers ?? {}) };
  servers.linkr = {
    type: 'stdio',
    command: process.execPath,
    args: [SERVER],
    env,
    enabled: true,
    description: 'Linkr KVM computer use: capture and control a remote machine',
    timeout: 30000,
  };
  next.mcpServers = servers;
  const content = `${JSON.stringify(next, null, 2)}\n`;
  if (args.dryRun) return { harness: 'minimaxcode', action: 'write', applied: false, configFile: path, preview: content };
  const written = await writeConfig(path, content);
  return { harness: 'minimaxcode', action: 'write', applied: true, configFile: written.path, backup: written.backup };
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.harness === '') {
    process.stdout.write(usage());
    process.exit(args.help ? 0 : 2);
  }

  const password = await resolvePassword(args);
  if (args.username.trim() === '') {
    // The device rejects an empty account; read it from the saved config when present.
    const fallback = await trySavedUsername();
    if (fallback === '') throw new Error('--username is required (the device account name)');
    args.username = fallback;
  }
  const env = entryEnvironment(args, password);
  // The packaged local plugin reads the same non-secret device configuration.
  if (!args.dryRun) {
    await writeConfig(join(homedir(), '.linkr', 'config.json'), `${JSON.stringify({ baseUrl: args.baseUrl, username: args.username, passwordFile: resolve(password.file) }, null, 2)}\n`);
  }
  if (!isAbsolute(SERVER)) throw new Error(`server path is not absolute: ${SERVER}`);
  if (!args.dryRun) {
    // Remember the account so a later run can omit --username.
    const saved = join(homedir(), '.linkr', 'username');
    await mkdir(dirname(saved), { recursive: true, mode: 0o700 });
    await writeFile(saved, `${args.username}\n`, { mode: 0o600 });
  }

  const targets = args.harness === 'all' ? HARNESSES : [args.harness];
  const results = [];
  for (const target of targets) {
    if (target === 'codex') results.push(await setupCodex(args, env, password));
    else if (target === 'opencode') results.push(await setupOpencode(args, env));
    else if (target === 'mimocode') results.push(await setupMimocode(args, env));
    else if (target === 'minimaxcode') results.push(await setupMinimaxcode(args, env));
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, server: SERVER, passwordFile: password.file, results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Linkr MCP server: ${SERVER}\n`);
  process.stdout.write(`Device: ${args.baseUrl} (account ${args.username})\n`);
  process.stdout.write(`Password: ${password.file}${password.created ? ' (created, mode 0600)' : ''}\n\n`);
  for (const result of results) {
    const verb = result.applied ? (result.action === 'run' ? 'ran' : 'wrote') : 'would';
    process.stdout.write(`- ${result.harness}: ${verb} ${result.action} ${result.configFile ?? ''}\n`);
    if (result.reason) process.stdout.write(`    ${result.reason}\n`);
    if (result.preview) process.stdout.write(`${result.preview.replace(/^/gm, '    ')}\n`);
    if (result.command) process.stdout.write(`    ${result.command}\n`);
  }
  process.stdout.write(
    [
      '',
      'Verify:',
      '  codex mcp list          # expect linkr',
      '  opencode mcp list       # expect linkr connected (run inside the project)',
      '  mimo mcp list           # expect linkr connected (run inside the project)',
      '  mcode mcp list --human  # MiniMaxCode',
      '',
      'Then check the device:  node mcp-linkr/index.js --status  (with the LINKR_* env)',
    ].join('\n'),
  );
}

async function trySavedUsername() {
  try {
    const text = await readFile(join(homedir(), '.linkr', 'username'), 'utf8');
    return text.trim();
  } catch {
    return '';
  }
}

main().catch((error) => {
  process.stderr.write(`setup: ${error.message}\n`);
  process.exit(1);
});
