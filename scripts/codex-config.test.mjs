import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateCodexConfig } from './codex-config.mjs';
const options = { command: '/node', server: '/server.js', environment: { LINKR_BASE_URL: 'http://fake', LINKR_USERNAME: 'tester', LINKR_PASSWORD_FILE: '/password' }, previous: { transport: { env: { KEEP: 'custom', LINKR_PASSWORD: 'old-secret' } } } };

test('updating transport preserves enabled state, tool filters, nested policies, and unrelated multiline strings', () => {
  const source = `model = "test"\nnotes = '''\n[mcp_servers.linkr]\ncommand="inside-string"\n'''\n[mcp_servers.linkr]\ncommand = "old-node"\nargs = [\n "old.js",\n]\nenabled = false\ndisabled_tools = ["linkr_computer_use"]\n[mcp_servers.linkr.env]\nLINKR_PASSWORD="old-secret"\n[mcp_servers.linkr.tools.linkr_computer_use]\napproval_mode = "prompt"\n[mcp_servers.other]\ncommand="untouched"\n`;
  const result = updateCodexConfig(source, options);
  assert.ok(result.includes("notes = '''\n[mcp_servers.linkr]\ncommand=\"inside-string\"\n'''"));
  for (const policy of ['enabled = false', 'disabled_tools = ["linkr_computer_use"]', 'approval_mode = "prompt"', 'command="untouched"', 'KEEP = "custom"']) assert.ok(result.includes(policy), policy);
  assert.ok(!result.includes('old-secret')); assert.ok(!result.includes('old.js')); assert.ok(result.includes('command = "/node"'));
  assert.equal(updateCodexConfig(result, options), result);
});
test('inline existing server tables fail safely instead of replacing their policies', () => {
  assert.throws(() => updateCodexConfig('[mcp_servers]\nlinkr={command="node",enabled=false}\n', options), /left unchanged/);
});
