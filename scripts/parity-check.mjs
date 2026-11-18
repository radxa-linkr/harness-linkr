#!/usr/bin/env node
/**
 * Drift guard between the two faces of the same transport.
 *
 * The DeepSeek Harness plugin (`dsh-linkr/`) and the MCP server (`mcp-linkr/`)
 * must expose the same computer-use vocabulary and carry the same safety rules
 * into the model. This checks the source of truth in both places, so changing
 * one action list without the other fails here instead of in a user's session.
 *
 *   node scripts/parity-check.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

function quotedList(sourceText, name) {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(sourceText);
  if (!match) throw new Error(`could not find ${name} in the source`);
  return [...match[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
}

function computerUseTool(tools) {
  const tool = tools.find((entry) => entry.name === 'linkr_computer_use');
  if (!tool) throw new Error('mcp-linkr has no linkr_computer_use tool');
  return tool;
}

async function main() {
  const dshTools = await readFile(join(ROOT, 'dsh-linkr', 'host', 'tools.js'), 'utf8');
  const dshConfig = await readFile(join(ROOT, 'dsh-linkr', 'host', 'config.js'), 'utf8');
  const mcpTools = await readFile(join(ROOT, 'mcp-linkr', 'tools.js'), 'utf8');
  const mcpConfig = await readFile(join(ROOT, 'mcp-linkr', 'config.js'), 'utf8');

  const dshActions = quotedList(dshTools, 'COMPUTER_ACTIONS');
  const mcpActions = computerUseTool(TOOLS).inputSchema.properties.action.enum;

  await check('both faces expose the same computer-use actions', () => {
    const left = [...dshActions].sort();
    const right = [...mcpActions].sort();
    if (left.join(',') !== right.join(',')) {
      throw new Error(`dsh=[${left.join(',')}] mcp=[${right.join(',')}]`);
    }
  });

  await check('both faces document the same core actions', () => {
    const core = ['capture', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait', 'paste', 'clipboard'];
    for (const action of core) {
      if (!dshActions.includes(action)) throw new Error(`dsh is missing ${action}`);
      if (!mcpActions.includes(action)) throw new Error(`mcp is missing ${action}`);
    }
  });

  await check('both tool descriptions carry the safety rules', () => {
    const dshTool = dshTools.slice(dshTools.indexOf("name: 'linkr_computer_use'"), dshTools.indexOf("name: 'linkr_panel'"));
    const mcpTool = JSON.stringify(computerUseTool(TOOLS));
    for (const [label, text] of [['dsh', dshTool], ['mcp', mcpTool]]) {
      for (const phrase of ['untrusted data', 'capture_after', 'pixels of the captured frame']) {
        if (!text.toLowerCase().includes(phrase.toLowerCase())) throw new Error(`${label} description is missing "${phrase}"`);
      }
    }
  });

  await check('both faces advertise the same codecs', () => {
    for (const [label, text] of [['dsh', dshConfig], ['mcp', mcpConfig]]) {
      for (const codec of ['auto', 'mjpeg', 'h264']) {
        if (!text.includes(`'${codec}'`)) throw new Error(`${label} config is missing codec ${codec}`);
      }
    }
    if (!dshTools.includes('paste')) throw new Error('dsh tools do not mention paste');
  });

  await check('both faces document the same device configuration', async () => {
    for (const key of ['LINKR_BASE_URL', 'LINKR_USERNAME', 'LINKR_PASSWORD', 'LINKR_CODEC']) {
      if (!mcpConfig.includes(key) && !mcpTools.includes(key)) throw new Error(`mcp does not read ${key}`);
    }
    // The DSH plugin keeps its settings in a profile row (default device IP);
    // the MCP server takes env vars. The example device must still be the same
    // machine, so the two document the same origin.
    if (!dshConfig.includes('linkr.local')) throw new Error('dsh default baseUrl linkr.local missing');
    const mcpReadme = await readFile(join(ROOT, 'mcp-linkr', 'README.md'), 'utf8');
    if (!mcpReadme.includes('linkr.local')) throw new Error('mcp README does not use the same example device');
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
