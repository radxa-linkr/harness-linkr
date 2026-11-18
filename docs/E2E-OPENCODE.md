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


## Native plugin (same day, second path)

A native OpenCode 2 plugin was added next to the MCP adapter: [`opencode/plugin`](../opencode/plugin/)
(package `opencode-linkr`), loaded from a project config — no MCP process.

```jsonc
{
  "plugins": [
    {
      "package": "file:///…/harness-linkr/opencode/plugin",
      "options": { "baseUrl": "http://linkr.local", "username": "admin", "passwordFile": "…" }
    }
  ]
}
```

`opencode --standalone debug config` lists the `plugins` entry (and the global
`opencode-linkr-bee` plugin, which was left untouched). A free-model run with the real device:

```
> build · deepseek-v4.1-flash-free
⚙ execute {"code":"const status = await tools.linkr_status();\nreturn status;"}
⚙ execute {"code":"const cap = await tools.linkr_computer_use({ action: \"capture\" });\nreturn cap;"}
DEVICE=admin
FRAME=1920x1080
```

The native tools are first-class (`tools.linkr_status`, `tools.linkr_computer_use`), not the MCP
namespace. Captures default to `<project>/.linkr/captures/`; the model read the saved JPEG and
described the screen ("KDE Plasma desktop … Konsole … pacman"). With the capture directory outside
the project, the host refuses the file read (`external_directory`), so the plugin only file-references
a capture that lies inside the session directory.


## Native plugin panel (same day)

`linkr_panel { action: "open" }` starts the plugin's loopback web panel. Verified against the real
device by loading the same server module the plugin uses:

```
url    http://127.0.0.1:54554/?t=<token>
page   200, html ok
stream first frame 2.3 s after opening, 197,361 bytes, 1920x1080
state  {"connected":true,"codec":"h264","width":1920,"height":1080,"subscribers":1}
reply  stream closed cleanly, device mode restored by dispose()
```

The fetched frame was the controlled host's desktop (1920×1080 KDE session), i.e. the panel is not
a mock: it serves the same session the tools drive. Input forwarding is covered by
`scripts/opencode-panel-smoke.mjs` (click/key/paste go through `linkr_computer_use`).
