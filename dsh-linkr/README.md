# dsh-linkr

A [Linkr](https://radxa.com) KVM-over-IP device as a
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: **the agent sees the
controlled host's screen and drives its mouse and keyboard**, and a person watches and takes over
in the same live screen panel in the Web UI's right column.

Verified end to end on 2026-11-06 against a Radxa Linkr at `linkr.local` (fw `1.6.0`) with a
1920×1080 Linux host behind it — MJPEG and H.264 paths both, including the video-mode restore.

## What you get

| Part | What it does |
| --- | --- |
| **Agent tools** | `linkr_computer_use` — one computer-use-style tool: `capture` (the JPEG comes back **inline**, no `read_image` round trip), `click`, `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `wait`, `paste` (clipboard + a chord, the path for Chinese and any non-ASCII text), `clipboard` (read the controlled machine's clipboard back as text), every action with `capture_after`; coordinates are pixels of the captured frame. Plus `linkr_status` (device, codec, fps and session state — read-only) and `linkr_panel` (open / focus / close the panel). `paste` / `clipboard` need the optional **Linkrd** plugin on the controlled machine. |
| **「电脑」panel** | A right-column tab next to *Workspace files* / *New terminal*, titled **电脑** with a **Linkr 共享电脑** card: the host's screen at 10–30 fps, clickable, with a focusable keyboard surface, a `codec · resolution · fps` line, connection controls, a settings form, and **打开 Linkr** which opens the device's own console in a new tab (device sign-in and management stay there). No enlarge mode: the panel is the picture. **粘贴 / Paste** puts text on the host from the clipboard (or from a small box when the shell refuses clipboard reads): ASCII goes through the HID keyboard, Chinese and other non-ASCII text through the Host's clipboard route (needs Linkrd), and the box also has **仅写入剪贴板 / Write to clipboard only** for terminals that paste with `Ctrl+Shift+V`. A `剪贴板 可用 / 不可用` line under the metrics says whether that route works, and a dismissible **Linkrd 安装指引 / Linkrd install guide** card explains the three install steps and never gates anything. Below the picture, **最近活动 / Recent activity** lists what the **agent** did to the computer — captures, clicks, keys, typed text, panel actions, session/codec events — phrased in your language (`点击 (42%, 31%)`, `按 Ctrl+Alt+T`), newest first, 100 rows, live over the same SSE channel. A person's own clicks are not recorded. |
| **Two codecs** | `codec: auto` (default) uses the device's **H.264** stream and decodes it with ffmpeg when ffmpeg is available, otherwise the device's **MJPEG** stream. See *Codecs* below. |
| **One session, two callers** | Tools, panel and routes share one `LinkrClient` and one media WebSocket to the device — one video-mode switch, one input path. |

## How it talks to the device

- `POST /api/account/login` with `sha256("RADXA_FIXED_SALT_v1" + password)` → Bearer token, then
  `POST /api/rtc/whep {"offer":"ws_mjpeg"|"ws_h264"}` → a short-lived `answer`, then
  `ws://<device>/ws/media?authorization=…` with subprotocol `ws-media`.
- On the MJPEG offer each binary message is one complete JPEG; on the H.264 offer each message is a
  ws-media packet (`type, pts, duration, size` header + AnnexB access unit) which the Host pipes
  through one ffmpeg child and splits back into JPEG frames. Either way everything above that
  pipeline — `linkr_screen`, the panel's `multipart/x-mixed-replace` route, `linkr_input` — sees
  the same JPEG frames and the same socket for input.
- Input goes back on the media socket as `[type][protobuf]`: keyboard (`1`) and mouse (`2`), the
  same frames the phone / TV / desktop clients send.
- The device's `video_codec` is a **global** setting (`1` MJPEG, `2` H.264 over WebSocket), so a
  session switches it to the codec's mode and **always restores the previous value** when it stops
  — on idle, on an explicit stop, on error and on plugin dispose (`manageVideoMode: false` forbids
  the write).
- An **API key** from the device UI cannot authenticate against `/api/*`: Bearer, `X-API-Key`,
  query parameter, login body and https all answer `403` (measured on fw 1.6.0). The plugin logs in
  with the device account.

## Codecs

| codec setting | device mode | transport | measured (1080p, fw 1.6.0) |
| --- | --- | --- | --- |
| `mjpeg` | 1 | `ws_mjpeg`, JPEG per message | ~37 source fps, ~319 KB/frame |
| `h264` | 2 | `ws_h264` → ffmpeg → JPEG | ~52 source packets/s, decoded to JPEG at up to ~56 fps |
| `auto` (default) | 1 or 2 | `h264` when ffmpeg is found, else `mjpeg` | as above |

**H.265 is not available to this plugin, and not because of the plugin**: the device only offers
H.265 over WebRTC (mode 3). Every WebSocket media offer is refused in mode 3 with the firmware's
`rpc Internal error` (verified); H.265 is only reachable over WebRTC. A Node
host cannot join a WebRTC session without a full WebRTC stack, so the honest options are MJPEG or
H.264; making H.265 work would mean the browser panel owning a WebRTC session and the agent
depending on an open panel. Not implemented.

The delivered frame rate is `streamFps` (default 20, range 1–60) — the older default of 10 was the
entire "the picture is slow" story. At 25 fps the H.264 path keeps ffmpeg at roughly two thirds of
one core (1080p decode + JPEG encode) and pushes ~7 MB/s over the loopback to the page.

## Clipboard (Linkrd)

The device can sync the clipboard with the controlled machine, but only when the optional **Linkrd**
plugin does the work on that side. Three things must be true, and the panel's guide names whichever
one is missing:

1. the device has Linkrd installed and enabled (device console → Plugin center);
2. the virtual disk `Linkrd.img` is mounted on the controlled machine;
3. the Linkrd program from that disk is running there.

When they are, the plugin opens the device's control WebSocket (`ws://<device>/ws`, no subprotocol —
`WsMessage` protobuf, `MessageType` 19/20 with bodies 42–45) on demand, and:

| Tool / route | What it does |
| --- | --- |
| `linkr_computer_use` `paste` | writes the clipboard with the session and revision the device handed out, then presses `keys` through the media socket (one atomic write instead of one key event per character) |
| `linkr_computer_use` `clipboard` | reads the controlled machine's clipboard back as text (up to 800 characters per answer) |
| `GET /linkr/clipboard` | `{ available, reason, message, enabled, connected, hasText, text: '', maxBytes }` — the panel's capability probe, cached 5 s, and it never carries the clipboard text |
| `POST /linkr/clipboard` | `{ text, keys? }` → `{ ok, bytes, maxBytes, revision, keys }`; `409` with a `reason` when Linkrd is off, disconnected or the device cannot answer; `409` while the session is stopped |

Details that matter:

- **Revision is a uint64.** It crosses the plugin as a decimal string and is only compared as `BigInt`; a JS number
  would silently corrupt it past 2^53.
- **A stale token costs one re-login.** The token travels in every `WsMessage`, so a 403 closes the socket, re-logs
  in and repeats the call once.
- **The socket is disposable.** It closes after 60 s idle and whenever the session tears down; nothing about the
  clipboard keeps the device awake.
- **Privacy.** Reading the clipboard returns text the user copied on that machine, which the screen may never show.
  The panel never displays it — only whether it is available — and the agent should treat it as private data.

## Requirements

- DeepSeek Harness `>=0.2.0-rc.1 <0.3.0` (`engines.dsh`); built and verified on `0.2.1-rc.5`,
  profile `desktop`.
- Node ≥ 22 (uses the global `fetch` / `WebSocket`; no npm dependencies).
- **ffmpeg** for H.264 (`brew install ffmpeg`, or set `ffmpegPath` / `$FFMPEG_PATH`). Without it the
  plugin runs MJPEG and says so once in `linkr_status` (`note:` line) instead of failing.
- A Linkr device on the LAN plus its device account name and password.
- The controlled host awake with a signal on the HDMI input.

## Install

```sh
# from the harness-linkr repository root
dsh plugin --profile desktop add "$(pwd)/dsh-linkr"
```

or from the Harness UI: **Plugins → install**, with the absolute path to this `dsh-linkr/` directory. A directory
install links the checkout, so edits to these files take effect on the next Harness restart (the
Host half) and page reload (the Web half).

Settings live in the active profile's `cordis.patch.yml` row `linkr`:

| Field | Meaning |
| --- | --- |
| `baseUrl` | device origin, e.g. `http://linkr.local` or `http://linkr.local` |
| `username` | device account name (`GET /api/account/info` reports it) |
| `password` | device password; empty = use the `linkr/device` credentials record |
| `codec` | `auto` \| `mjpeg` \| `h264` |
| `ffmpegPath` | ffmpeg executable; empty = `$FFMPEG_PATH`, `/opt/homebrew/bin/ffmpeg`, then PATH |
| `jpegQuality` | ffmpeg `-q:v` for the H.264 path, 1 (best) … 10 (smallest) |
| `manageVideoMode` | switch the device to the codec's mode while live, restore afterwards |
| `streamFps` | frames per second handed to the panel, 1–60 (default 20). Above ~37 only H.264 can keep up; at 60 expect ~9–18 MB/s over the loopback and noticeable JPEG-decode CPU in the page |
| `idleStopMs` | stop the session (and restore the mode) after this long without use |
| `screenshotDir` | where `linkr_screen` writes, resolved against the session working directory; empty = `<session>/.linkr` |

The panel's ⚙ writes `baseUrl` / `username` / `codec` / `streamFps` / `jpegQuality` / `ffmpegPath`
through the Harness config editor and the password to the **credentials record**
(`linkr/device`), so the password never lands in the config file. A saved config restarts the Host
plugin, so the panel re-reads state, reconnects and re-arms the stream; the bar keeps showing the
**effective** codec (an `auto` that resolved to H.264 reads `H.264`). Measured effect of the
quality knob at 1080p H.264: `jpegQuality: 4` → ~300 KB/frame, 6.8 MB/s at 24 fps;
`jpegQuality: 6` → 163 KB/frame, 3.7 MB/s at the same rate.

## Use

- **Paste**: two paths. ASCII goes through the device's US-layout HID keyboard (`type`), which refuses a
  character it cannot type by name (`cannot type "中" (U+4E2D)`) instead of dropping it silently (the device's own
  `/api/paste` drops it). Anything else goes through **Linkrd's clipboard**: `paste` writes the controlled machine's
  clipboard over the device's control socket and then presses a chord (default `ctrl+v`, `ctrl+shift+v` in a terminal,
  `keys: ""` for clipboard only), and `clipboard` reads it back as text. Without Linkrd both are refused with a
  sentence that says which of the three install steps is missing. See *Clipboard (Linkrd)*.
- **Agent**: ask it to look at the screen, then to click or type. `linkr_computer_use` returns the
  capture inline and `capture_after` verifies an action in the same call. `linkr_panel open` makes
  the work visible to you.
- **Person**: right column → **电脑** → click into the picture to focus, then type. The activity
  list under the picture shows the agent's calls (and yours) as they happen. **断开**
  stops the session and gives the device its video mode back; **连接** or **刷新画面** resumes.

Session semantics that matter:

- A capture, an input action, `POST /linkr/connect` or a saved config starts a session;
  `POST /linkr/disconnect` stops one and **stays stopped** — while stopped, the panel's stream and
  the frame route answer `409` instead of silently re-opening it (`state.stopped` is how the panel
  knows not to retry). `linkr_status` is read-only and never clears the stop.
- `idleStopMs` after the last use the session stops by itself, restores the device mode and kills
  the decoder.

## Security notes

- The password never appears in a tool result, a log line or the config file when the credentials
  service is present; `GET /linkr/config` answers `••••••`. The Harness credentials store itself is
  a `0600` YAML file under `~/.dsh` (plaintext, by design of that service).
- The plugin's HTTP routes are same-origin guarded, and they can type into a real machine: treat the
  page as a remote control.
- A pressed chord is released in reverse order; an abandoned drag is released; a stopped session
  kills its ffmpeg child.

## Verification (this build)

Real device `linkr.local`, Linux host 1920×1080, 2026-11-06:

| Check | Result |
| --- | --- |
| `npm test` (`node --test test/*.test.mjs`) | 84/84 pass — HID golden vectors, ws-media packet parse, ffmpeg discovery, MJPEG and H.264 sessions against a fake device, control-WS clipboard golden frames (status reply, text request, ping→pong, 403, timeout, `MaxTextBytes`), locale/dictionary key parity |
| `node test/host-smoke.mjs` | 51/51 pass — every route and tool, cross-origin 403, config persistence, credentials write, explicit stop, H.264 and the no-decoder fallback, and the clipboard route answering `200` with a reason / `400`/`409` instead of crashing when Linkrd is missing |
| `linkr_status` on the live plugin | device `admin`, fw `1.6.0`, model Radxa Linkr, sn `<serial>` |
| `linkr_computer_use capture` | 1920×1080 JPEG delivered **inline in the tool result** (no `read_image`), frame 25–35 ms old, file kept at `<session>/.linkr/capture-…jpg` |
| `linkr_computer_use wait` + `capture_after` | action executed and a second inline capture returned in the same call |
| pointer move to (0.5, 0.5) | pointer found at (960, 540) in the next capture, cropped and checked |
| key `Escape` | closed an address-bar dropdown that was open on the host |
| `ctrl+t` + type `linkr agent ok` + `ctrl+w` | new tab opened, the text appeared in its address bar, the tab closed again |
| codec `auto` on hardware | `state.codec: h264`, `state.decoder: ffmpeg`, device mode `2`, decoded rate 52 fps |
| `/linkr/live.mjpeg` at `streamFps: 25` | 24.0 frames/s, 6.8 MB/s, ffmpeg at ~64 % of one core |
| MJPEG path at `streamFps: 25` | 24.8 frames/s, 7.4 MB/s |
| `POST /linkr/disconnect` | `connected:false, videoMode:0, modeOwned:false, stopped:true`, stayed stopped across 15 s of client retries; device's own `GET /api/video/codec` read `0`, no ffmpeg process left |
| Panel registration | `dsh-linkr` is an active occupant of `sidebar.right.pane.tab`; the stream route served `multipart/x-mixed-replace` |
| Device console | reachable at `http://<device>/` for 打开 Linkr; device sign-in happens there, not in the panel |

**Not verified here**: the panel's rendered appearance — the 电脑 card, the header row, the
`codec · resolution · fps` line, the pointer/keyboard feel (no browser control in this session).
The tab registers, its routes and stream work, and the client half is self-checked.

## Layout

```
dsh-linkr/
├─ index.js            Host entry: name / inject / Config / apply (wiring only)
├─ host/
│  ├─ config.js        config defaults, normalisation, Config standard-schema
│  ├─ client.js        the single LinkrClient lifecycle, capture directory, status text
│  ├─ activity.js      bounded activity ring, SSE publishing, /linkr/log payload
│  ├─ routes.js        the /linkr/* routes (state, config, connect, input, mjpeg, panel, log)
│  └─ tools.js         linkr_status, linkr_computer_use, linkr_panel
├─ lib/                transport: linkr.js (HTTP/auth), media.js (WHEP + MJPEG/H.264 + ffmpeg),
│                      ffmpeg.js (discovery/spawn), hid.js (HID protobuf), control.js (control WS +
│                      Linkrd clipboard protobuf), client.js (orchestration)
├─ client.js           Web half: the 「电脑」 tab (picture, pointer/keyboard, paste, settings, log)
├─ locale/en.json, zh.json   copy + plugin meta.title / meta.description
├─ icon.svg            plugin icon
├─ cordis.patch.yml    the bundle's row and its defaults
├─ docs/DESIGN.md      architecture, session model, routes, config, limitations
├─ docs/CONTRACT.md    the append-only build journal with the measured protocol facts
├─ test/               unit tests, fake device, host smoke, opt-in real-device smoke
├─ CHANGELOG.md
└─ LICENSE (GPL-3.0-only)
```

## Development

```sh
node --test test/*.test.mjs        # transport + locale unit tests (fake device, no network)
node test/host-smoke.mjs           # Host half: every route and tool against a ctx stub
LINKR_BASE_URL=... LINKR_PASSWORD=... LINKR_SMOKE=1 \
  node --test test/smoke.mjs       # opt-in real-device smoke
```

A directory install links this checkout into the Harness profile: Host-half edits take effect after
restarting the app (or toggling the plugin), Web-half edits after a page reload.

## Licence

GPL-3.0-only.
