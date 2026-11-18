# End-to-end evidence: OpenCode 2 → Linkr MCP server → real device

Device names, addresses and serials in these records are redacted (`admin` / `linkr.local` are placeholders).

Date: 2026-11-18. Harness: **`opencode 2.2.7`** (the V2 line). Model:
`opencode/deepseek-v4.1-flash-free` (OpenCode's free tier, so this run spent nothing). Device:
Radxa Linkr on the LAN, fw 1.6.0, 1920×1080 host.

The project lived in a throwaway directory with only a project-level `opencode.json` written by
`scripts/setup.mjs`; the user's global OpenCode configuration was not modified.

## Config (OpenCode 2 shape)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "linkr": {
        "type": "local",
        "command": ["<node>", "<repo>/mcp-linkr/index.js"],
        "environment": { "LINKR_BASE_URL": "http://linkr.local", "LINKR_USERNAME": "admin", "LINKR_PASSWORD_FILE": "…" }
      }
    }
  }
}
```

`opencode --standalone debug config` resolves it (secrets masked). OpenCode 2.2.7's
`opencode mcp list` does **not** report project-configured servers (it prints "No MCP servers
configured" even though the server loads — verified), so the real run below is the proof.

## Command

```sh
cd /tmp/opencode-e2e        # opencode.json from scripts/setup.mjs, LINKR_* env inside it
opencode run --standalone -m opencode/deepseek-v4.1-flash-free \
  'Use the linkr MCP tools. Call linkr_status first, then linkr_computer_use with
   action=capture. Reply with exactly two lines: DEVICE=<deviceName> and FRAME=<width>x<height>.
   Do not run shell commands.'
```

`--standalone` keeps the run off the desktop app's managed service socket.

## What OpenCode 2 reported

```
> build · deepseek-v4.1-flash-free
⚙ execute {"code":"const r = await tools.search({ query: \"linkr_status\" });\nreturn r;"}
⚙ execute {"code":"const s = await tools.linkr.linkr_status();\nreturn s;"}
⚙ execute {"code":"const c = await tools.linkr.linkr_computer_use({ action: \"capture\" });\nreturn c;"}
DEVICE=admin
FRAME=1920x1080
```

OpenCode 2 runs tools in its code sandbox, where MCP tools are namespaced
`tools.linkr.linkr_status` / `tools.linkr.linkr_computer_use`. Both calls reached the shared server
and used the real device; the capture was written to the server's `LINKR_SAVE_DIR`.

## Server-side trace (`LINKR_MCP_LOG_FILE`)

A second, minimal run (`Call the linkr_status tool once.`) was traced on the server:

```
<- initialize
<- notifications/initialized
<- tools/list
<- tools/call
```

So OpenCode 2's MCP client speaks the same handshake/tools protocol as before; only the user-facing
config shape changed (`mcp.servers`, `disabled` instead of `enabled`).

## Reproduce

```sh
node scripts/setup.mjs --harness opencode --username <account> --password-file <file> --project .
cd <project> && opencode --standalone debug config | grep -A3 linkr
opencode run --standalone -m <model> 'Call linkr_status and reply DEVICE=<deviceName>.'
```
