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

**Desktop app panel:** OpenCode Desktop loads `./gui-experimental` parts from the plugins of the
server it runs, so put this entry in the **global** `~/.config/opencode/opencode.json(c)` to get the
sidebar tab in every window. A project-level `opencode.json` entry still gives the agent tools, but
the desktop panel is not registered from it. Verify with the app's plugin API:
`curl -u opencode:<service password> http://127.0.0.1:<port>/api/plugin` should list
`opencode-linkr` with `"gui": true` and `state.status: "active"`.

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

## Desktop app panel (OpenCode GUI part)

`./gui-experimental` is a prebuilt OpenCode GUI plugin part: the desktop app evaluates it in every
window, so the panel lives **in the session sidebar** next to the conversation, like the DSH
right-column panel.

- Open it with the command palette command **Linkr: 打开/关闭共享电脑画面** (default binding
  **Ctrl+Alt+L**), or from the session's panel menu (**Linkr 共享电脑**).
- The panel follows the app's appearance (light/dark): the GUI part passes `ctx.appearance.mode()`
  to the page, which keeps its own light/dark palette.
- **设置** (in the panel header) edits the connection in place: device address, account, password
  (blank keeps the saved one) and codec. Saving writes `~/.linkr/opencode-plugin.json` (0600, over
  the `opencode.json` options and `LINKR_*` environment), rebuilds the device tools and reloads the
  panel. It never touches `opencode.json`. The file is `0600`; the password is only present if it was
  typed into the form (a `passwordFile`/environment password is left where it is).
- The tab opens in the session's side region (560 px) and renders the loopback page in an iframe
  (`&embed=1`, so the page drops its outer chrome); **刷新** reloads it and **在浏览器打开** opens the
  standalone page.
- The window side has no Node access, so it asks the server part for the panel URL over the
  `opencode-linkr.panel` RPC; the server starts the same panel server `linkr_panel` uses.

The bundle is `dist/gui-experimental.cjs` (≈5 KiB, committed). Rebuild it after editing `gui/`:

```sh
cd opencode/plugin
npm run build:gui        # vite build --config vite.config.mjs
```

The GUI bundle keeps the app-provided modules external (`@opencode/plugin/gui`,
`@opencode/plugin/rpc`, `solid-js`, `solid-js/web`), which is what the OpenCode GUI Vite preset
enforces. It is part of the desktop app; the browser web UI served by `opencode serve` does not load
GUI plugin parts.

## Live panel

The agent can open the panel:

> Open the Linkr panel.

which calls `linkr_panel { action: "open" }` and returns a URL like
`http://127.0.0.1:54321/?t=<token>`. Open it in any local browser: the page shows the same
session the tools drive, with the controls a person needs — full-width live picture, click /
double-click / right-click / drag / scroll, keyboard (the picture keeps focus), paste box
(Unicode goes through the Linkrd clipboard path), screenshot download, **断开**, and the agent's
recent activity.

- **Loopback only.** The server binds `127.0.0.1` and picks a random port. The HTML page and its
  static assets contain no device data and load without the token (the browser cannot put the query
  string on `<link>`/`<script>`); every data/input endpoint (`/stream`, `/frame.jpg`, `/state.json`,
  `/input.json`) requires the random `?t=` token. Do not paste the URL into a shared chat or expose
  the port on a LAN.
- The page and the agent share one device session; a person's click is noted in the same activity
  list. `linkr_panel { action: "close" }` stops the page (and plugin unload closes it too).
- The panel starts the stream when it opens; closing the page leaves the session to the tools
  (and the device's idle-stop).
- If the plugin server was reloaded while the page was open, the page reports the stale URL to the
  desktop panel (`postMessage`), which asks the RPC for a fresh URL and reloads the iframe; the
  header **刷新** does the same manually.
- The page is also served standalone (the URL from `linkr_panel`); there it follows the system
  light/dark preference.

## Notes

- One Linkr session per machine: the device lease is shared with the DSH plugin and the MCP adapter.
  If another local panel (e.g. the DSH 「电脑」 tab) is streaming the same device, the Linkr panel
  starts but the page shows the lease sentence instead of a picture — disconnect the other session
  first. The error is surfaced verbatim in the panel's stage hint and `/state.json`.
- The plugin loads lazily: no device connection, session or ffmpeg until the first tool call.
- It shares the same on-disk device lease/journal as the MCP adapter, so an agent using one
  integration cannot stomp a session held by the other.
- This is the **repository-local build**: `index.js` imports `../../mcp-linkr/`. A published npm
  package would bundle that runtime (and the materialized transport) first.
- The live panel is the loopback web page above; an in-app TUI/desktop part is not included yet.
- GPL-3.0-only, like the rest of the repository.
