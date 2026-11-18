# opencode-linkr — native OpenCode 2 plugin

The Linkr KVM as a first-class **OpenCode 2.x plugin**: two tools, no MCP process,
backed by the same transport and the same `mcp-linkr` runtime the DSH plugin and the
MCP adapters use. Verified with **opencode 2.2.7**.

| Tool | What it does |
| --- | --- |
| `linkr_status` | Read-only device/session report: device name, firmware, model, serial, online state, codec, live frame size and fps, and the one-line fix when something is wrong. |
| `linkr_computer_use` | One computer-use tool: `capture`, `click`, `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `wait`, `paste`, `clipboard`, plus `capture_after` and `save`. Same schema and semantics as the MCP adapter. |
| `linkr_panel` | Open/close the live **web panel**: a loopback page with the real-time screen (MJPEG), pointer/keyboard input, paste, screenshot and recent activity. `open` returns the URL. |

OpenCode 2 runs tools in its code sandbox, so the model calls them as
`tools.linkr_status()` / `tools.linkr_computer_use({...})` inside `execute`, or as normal
tool calls. A capture returns a file content block pointing at the saved JPEG **and**
the text with size/path, so the model can look at the screen.

## Requirements

- **OpenCode >= 2.2.0** (verified 2.2.7). The package declares `engines.opencode`.
- **Node.js >= 22** available to OpenCode's runtime.
- This checkout must have the transport materialized once:
  `node scripts/sync-core.mjs` from the repository root (the plugin imports `mcp-linkr/`,
  which imports the materialized `dsh-linkr/lib/`).
- The plugin's own dependency (`@opencode/plugin` 2.2.7), installed in this directory:

  ```sh
  cd opencode/plugin
  npm install --no-audit --no-fund     # node_modules is gitignored
  ```

## Install

Configure it in a project's `opencode.json` (or the global
`~/.config/opencode/opencode.json`). Relative paths resolve from the config file; use an
absolute `file://` URL for a checkout:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///absolute/path/to/harness-linkr/opencode/plugin",
      "options": {
        "baseUrl": "http://linkr.local",
        "username": "admin",
        "passwordFile": "~/.linkr/password"
      }
    }
  ]
}
```

`.opencode/plugins/` auto-discovery also works for the directory, but discovered plugins get
no `options`; use the `plugins` entry when you want to pass settings.

Restart OpenCode (or the server) after changing the config. A plugin that fails to import is
shown by `opencode --standalone debug config` and in the server logs.

## Options

Every option maps 1:1 onto the MCP adapter's environment variable; the environment is used
when an option is absent, so a shell that already exports `LINKR_*` needs no config change.

| Option | Environment | Meaning |
| --- | --- | --- |
| `baseUrl` | `LINKR_BASE_URL` | Device origin, e.g. `http://linkr.local` |
| `username` | `LINKR_USERNAME` | Device web account |
| `password` | `LINKR_PASSWORD` | Device web password (prefer `passwordFile`) |
| `passwordFile` | `LINKR_PASSWORD_FILE` | File containing the password |
| `codec` | `LINKR_CODEC` | `auto` (default), `mjpeg`, `h264` |
| `streamFps` | `LINKR_STREAM_FPS` | Frame rate, default 20 |
| `jpegQuality` | `LINKR_JPEG_QUALITY` | H.264 path ffmpeg `-q:v`, default 4 |
| `ffmpegPath` | `LINKR_FFMPEG_PATH` | ffmpeg binary; empty = search |
| `saveDir` | `LINKR_SAVE_DIR` | Capture directory; **default `<project>/.linkr/captures`** |
| `idleStopMs` | `LINKR_IDLE_STOP_MS` | Stop an idle session after this long |
| `manageVideoMode` | `LINKR_MANAGE_VIDEO_MODE` | Leave the device's video mode as found (default true) |

Captures default to `<project>/.linkr/captures` so the session can read the JPEG without an
external-directory permission prompt. Add `.linkr/` to the project's `.gitignore`. If you
point `saveDir` outside the project, the plugin still returns the path as text but does not
file-reference it (the host would refuse the read).

## Verify

```sh
# the config resolves and lists the plugin
opencode --standalone debug config | grep -A4 plugins

# a real run (free model), no shell tools needed
opencode run --standalone -m opencode/deepseek-v4.1-flash-free \
  'Call linkr_status, then linkr_computer_use with action=capture. Reply DEVICE=<deviceName> FRAME=<w>x<h>.'
```

Expected: the model calls `tools.linkr_status()` / `tools.linkr_computer_use({action:"capture"})`
and answers with the device name and frame size; the capture JPEG is under `.linkr/captures/`
and the model can describe the screen from it.

## Live panel

The agent can open the panel:

> Open the Linkr panel.

which calls `linkr_panel { action: "open" }` and returns a URL like
`http://127.0.0.1:54321/?t=<token>`. Open it in any local browser: the page shows the same
session the tools drive, with the controls a person needs — full-width live picture, click /
double-click / right-click / drag / scroll, keyboard (the picture keeps focus), paste box
(Unicode goes through the Linkrd clipboard path), screenshot download, **断开**, and the agent's
recent activity.

- **Loopback only.** The server binds `127.0.0.1`, picks a random port and requires a random token
  on every request (`?t=`). Do not paste that URL into a shared chat or expose it on a LAN.
- The page and the agent share one device session; a person's click is noted in the same activity
  list. `linkr_panel { action: "close" }` stops the page (and plugin unload closes it too).
- The panel starts the stream when it opens; closing the page leaves the session to the tools
  (and the device's idle-stop).
- This is a **browser page**, not an in-app OpenCode TUI/desktop part: those need the separate
  `@opencode/plugin/tui` / `gui` APIs and a Solid/OpenTUI build. The page works in any browser and
  can be embedded later if an in-app panel is wanted.

## Notes

- The plugin loads lazily: no device connection, session or ffmpeg until the first tool call.
- It shares the same on-disk device lease/journal as the MCP adapter, so an agent using one
  integration cannot stomp a session held by the other.
- This is the **repository-local build**: `index.js` imports `../../mcp-linkr/`. A published npm
  package would bundle that runtime (and the materialized transport) first.
- The live panel is the loopback web page above; an in-app TUI/desktop part is not included yet.
- GPL-3.0-only, like the rest of the repository.
