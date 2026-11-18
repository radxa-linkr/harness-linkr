#!/usr/bin/env node
/**
 * Protocol-compliance check against the **official MCP SDK client**.
 *
 * Our own smoke test speaks JSON-RPC by hand; this one validates the server
 * through `@modelcontextprotocol/sdk` (the reference client), so the wire shape
 * is checked by an implementation we did not write.
 *
 * The SDK is optional: without it the script prints SKIP and exits 0, so the
 * default test run stays dependency-free. Install it anywhere and point the
 * script at it:
 *
 *   npm install @modelcontextprotocol/sdk
 *   MCP_SDK_DIR=$PWD/node_modules node scripts/mcp-compliance.mjs
 *
 * Modes:
 *   (default)  fake Linkr device from dsh-linkr/test/fake-device.mjs
 *   --real     the device from LINKR_BASE_URL / LINKR_USERNAME / LINKR_PASSWORD
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp-linkr', 'index.js');
const realDevice = process.argv.includes('--real');

/** Load the SDK from MCP_SDK_DIR when given, else from the module graph. */
async function loadSdk() {
  const sdkDir = process.env.MCP_SDK_DIR;
  if (sdkDir) {
    // Resolve inside the package the way its `exports` map does: either the
    // legacy direct path or the `dist/esm/*` layout of the published package.
    const base = resolve(sdkDir, '@modelcontextprotocol/sdk');
    const pick = (name) => {
      for (const candidate of [join(base, 'client', name), join(base, 'dist', 'esm', 'client', name)]) {
        if (existsSync(candidate)) return candidate;
      }
      throw new Error(`cannot find ${name} under ${base}`);
    };
    const clientPath = pathToFileURL(pick('index.js')).href;
    const stdioPath = pathToFileURL(pick('stdio.js')).href;
    return { Client: (await import(clientPath)).Client, StdioClientTransport: (await import(stdioPath)).StdioClientTransport };
  }
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client, StdioClientTransport };
  } catch {
    return null;
  }
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

async function main() {
  const sdk = await loadSdk();
  if (sdk === null) {
    console.log('SKIP  official MCP SDK is not installed (npm install @modelcontextprotocol/sdk, then MCP_SDK_DIR=…).');
    console.log('\nSKIPPED');
    return 0;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'linkr-compliance-'));
  const env = {
    ...process.env,
    LINKR_SAVE_DIR: join(scratch, 'captures'),
    LINKR_STATE_DIR: join(scratch, 'state'),
    LINKR_INLINE_IMAGES: '1',
  };
  let fake = null;
  try {
    if (realDevice) {
      for (const key of ['LINKR_BASE_URL', 'LINKR_USERNAME', 'LINKR_PASSWORD']) {
        if (!process.env[key]) throw new Error(`--real needs ${key}`);
      }
    } else {
      const { createFakeDevice } = await import(join(ROOT, 'dsh-linkr', 'test', 'fake-device.mjs'));
      fake = createFakeDevice({ username: 'tester', password: 's3cret', initialCodec: 0, frameIntervalMs: 40 });
      env.LINKR_BASE_URL = await fake.listen();
      env.LINKR_USERNAME = 'tester';
      env.LINKR_PASSWORD = 's3cret';
      env.LINKR_CODEC = 'mjpeg';
    }

    const transport = new sdk.StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'pipe' });
    const client = new sdk.Client({ name: 'harness-linkr-compliance', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    const server = client.getServerVersion();
    check('official SDK: connect + initialize', () => {
      if (!server || server.name !== 'linkr') throw new Error(`unexpected server ${JSON.stringify(server)}`);
      if (!client.getServerCapabilities()?.tools) throw new Error('server advertises no tools capability');
    });

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    check('official SDK: tools/list', () => {
      if (names.join(',') !== 'linkr_computer_use,linkr_panel,linkr_panel_frame,linkr_panel_input,linkr_status') throw new Error(`tools are ${names.join(',')}`);
    });

    const uiResources = await client.listResources();
    const uiUri = listed.tools.find(tool => tool.name === 'linkr_panel')?._meta?.ui?.resourceUri;
    check('official SDK: side-panel resource and thread entrypoint', () => {
      if (!uiResources.resources.some(resource => resource.uri === uiUri)) throw new Error('screen UI resource is missing');
      const panel = listed.tools.find(tool => tool.name === 'linkr_panel');
      if (panel?._meta?.['openai/ui']?.entrypoints?.[0]?.type !== 'thread') throw new Error('thread entrypoint is missing');
    });
    const ui = await client.readResource({ uri: uiUri });
    check('official SDK: self-contained MCP App HTML', () => {
      if (!ui.contents[0]?.text?.includes('ui/initialize')) throw new Error('app handshake is missing');
      if (ui.contents[0]?.mimeType !== 'text/html;profile=mcp-app') throw new Error('wrong UI MIME type');
    });

    const computer = listed.tools.find((tool) => tool.name === 'linkr_computer_use');
    check('official SDK: computer-use schema is a valid object schema', () => {
      const schema = computer?.inputSchema;
      if (!schema || schema.type !== 'object') throw new Error('inputSchema is not an object schema');
      const actions = schema.properties?.action?.enum ?? [];
      for (const action of ['capture', 'click', 'drag', 'type', 'key', 'paste', 'clipboard']) {
        if (!actions.includes(action)) throw new Error(`action ${action} missing`);
      }
      if (schema.required?.join(',') !== 'action') throw new Error('required is not [action]');
    });

    const status = await client.callTool({ name: 'linkr_status', arguments: {} });
    const statusText = status.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    check('official SDK: linkr_status answers', () => {
      if (status.isError) throw new Error(statusText);
      const expected = realDevice ? /Radxa Linkr/ : /Fake Linkr/;
      if (!expected.test(statusText)) throw new Error(statusText.slice(0, 200));
    });

    const capture = await client.callTool({ name: 'linkr_computer_use', arguments: { action: 'capture' } });
    const image = capture.content.find((block) => block.type === 'image');
    check('official SDK: capture returns an MCP image block', () => {
      if (!image) throw new Error('no image content block');
      if (image.mimeType !== 'image/jpeg') throw new Error(`mimeType ${image.mimeType}`);
      if (typeof image.data !== 'string' || image.data.length < 1000) throw new Error('image data is empty');
    });

    if (fake) {
      const before = fake.hidFrames.length;
      const click = await client.callTool({ name: 'linkr_computer_use', arguments: { action: 'click', coordinate: [10, 10] } });
      await new Promise((done) => setTimeout(done, 300));
      check('official SDK: an input action reaches the device', () => {
        if (click.isError) throw new Error(click.content.map((block) => block.text).join(' '));
        if (fake.hidFrames.length <= before) throw new Error('no HID frame arrived');
      });
    }

    await client.close();
    if (fake) {
      await new Promise((done) => setTimeout(done, 300));
      check('official SDK: closing the client restores the device mode', () => {
        if (fake.codec !== 0) throw new Error(`codec is ${fake.codec}`);
      });
    }
  } finally {
    if (fake) await fake.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(1);
  });
