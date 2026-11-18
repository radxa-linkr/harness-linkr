# Protocol compliance: the official MCP SDK client

Device names, addresses and serials in these records are redacted (`admin` / `linkr.local` are placeholders).

Our own smoke test speaks JSON-RPC by hand, which proves our framing but not that a
third-party MCP client agrees. This check connects with **`@modelcontextprotocol/sdk`**
(`1.32.2`, the reference client) over a real stdio pipe.

```sh
# once, anywhere
npm install @modelcontextprotocol/sdk

# fake device (no hardware needed)
MCP_SDK_DIR=$PWD/node_modules node scripts/mcp-compliance.mjs

# real device
LINKR_BASE_URL=http://linkr.local LINKR_USERNAME=… LINKR_PASSWORD=… \
  MCP_SDK_DIR=$PWD/node_modules node scripts/mcp-compliance.mjs --real
```

## Result

Fake device and real device (2026-11-08, fw 1.6.0): **ALL PASS**.

| Check | Result |
| --- | --- |
| `connect` + `initialize` | server `linkr 0.1.0`, tools capability advertised |
| `tools/list` | exactly `linkr_computer_use`, `linkr_status` |
| computer-use input schema | object schema; `action` enum carries the full action set; `required: [action]` |
| `linkr_status` | answers over the SDK transport (fake: `Fake Linkr`; real: `admin, fw 1.6.0, Radxa Linkr`) |
| `capture` | returns an MCP `image` content block (`image/jpeg`, base64 payload) |
| input action (fake device) | `click` produces HID frames on the device socket |
| client close | the server restores the device video mode |

The SDK is deliberately optional: `node scripts/test-all.mjs` runs this script too, and it prints
`SKIP` and exits 0 when the SDK is not installed, so the repository stays dependency-free.

## Harness MCP clients (no model involved)

Each installed harness was pointed at the server with `LINKR_MCP_LOG_FILE` set, and the server traces
every method it receives. This shows what the harness's own MCP client does when the user opens the
harness, without spending model tokens:

| Harness | Command | Server methods observed |
| --- | --- | --- |
| OpenCode 1.18.35 | `opencode mcp list` | `initialize`, `notifications/initialized`, `tools/list` |
| MiMoCode 0.1.15 | `mimo mcp list` | `initialize`, `notifications/initialized`, `tools/list` |
| Codex 0.166.0 | `codex mcp list` | none — the command only reads the config; Codex connects the server when a session starts, which the real run in [`E2E-CODEX.md`](E2E-CODEX.md) proved |
| MiniMaxCode 0.7.6 | `mcode mcp` has only login/logout | not observable this way |

So OpenCode and MiMoCode discover both tools (`tools/list`) as part of loading the server; Codex
discovery and tool invocation are covered by the end-to-end run.

`LINKR_MCP_LOG_FILE` is a debugging aid, not a state file: it only appends method names and errors
(never the device password, never frame bytes).
