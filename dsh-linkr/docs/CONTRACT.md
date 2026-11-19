# dsh-linkr — build contract

A DeepSeek Harness plugin that turns a **Linkr KVM device** into the agent's eyes and hands on
the **controlled host computer**: the agent can grab the host's screen and inject mouse/keyboard
input, and a person can watch and take over in the same live screen panel in the Web UI's right
column. Verified end to end against a real device on 2026-11-06.

Everything below is the shared contract. These parts own disjoint files:

| Workstream | Files it owns | May read |
| --- | --- | --- |
| transport | `lib/**`, `test/**` | everything here |
| host | `index.js` | `lib/**` (contract only) |
| panel | `client.js`, `locale/**`, `icon.svg` | everything here |
| Maintainer | `package.json`, `cordis.patch.yml`, `CONTRACT.md`, `README.md`, install + verification | everything |

Do not edit a file another workstream owns. If the contract is wrong or impossible, say so in your
report; the maintainer changes this file.

---

## 1. The device protocol (facts, all observed live)

Device under test: `http://linkr.local` (Radxa Linkr, fw `1.6.0`), LAN only, HTTP on :80.
A second device may be reachable as `linkr.local`; never hard-code a host beyond the default below.

Envelope: every JSON answer is `{ "code": 0, "message": "", "data": { ... } }`. `code === 0` is
success. Auth failures are HTTP **403** with `{"code":403,"message":"No Permisson"}`.

### 1.1 Auth

`POST /api/account/login` with `{"username": "...", "passwd": "<hex>"}` where hex is
`sha256("RADXA_FIXED_SALT_v1" + plaintext)` lowercase. Answer: `data.token` (JWT) and
`data.require_two_factor`. All authed calls send `Authorization: Bearer <token>`.

- An **API key** from the device UI (`radxa_linkr_…`) is NOT an HTTP credential: Bearer,
  `X-API-Key`, query parameter, login body and https all answer 403. Do not build on it.
- `POST /api/account/refresh` exists for the cookie-based browser flow; not needed here.
- On 403 with a stored token: re-login once, then fail with a clear message.

### 1.2 Device information

| Call | Auth | Answer |
| --- | --- | --- |
| `GET /linkr/info` | no | `data.{deviceName,status,onlineTime,heartbeat,version}` |
| `GET /api/device/info` | yes | `data.{model,sn,eth0_mac,wlan0_mac,wlan1_mac,domain_name}` |
| `GET /api/device/version` | yes | `data.{version}` |
| `GET /api/account/info` | yes | `data.{username}` |
| `GET /api/video/codec` | yes | `data.{video_codec}` — see 1.3 |

`/linkr/info` is rate limited by the firmware (`X-Rate-Limit-Limit: 2`), so poll it at most about
once a second and never in a tight loop.

### 1.3 Video mode (the one setting the plugin changes)

`video_codec`: `0` WebRTC default, `1` MJPEG over WebSocket, `2` H.264 over WebSocket, `3` H.265,
`-1` AUTO. Set with `POST /api/video/codec {"video_codec": 1}`.

**MJPEG (1) is the only mode that yields JPEG frames to a plain Node process**, so a capture
session must switch the device to it:

1. read `GET /api/video/codec`, remember the value;
2. if it is not `1`, `POST /api/video/codec {video_codec: 1}` and wait ~800 ms;
3. work;
4. **always restore** the remembered value when the session stops (idle stop, panel closed,
   plugin dispose, error). A device left in MJPEG would break somebody's WebRTC session.

`manageVideoMode: false` in config means "never write the device setting": then a session only
starts if the device is already in mode 1, otherwise it fails with an explicit message.

### 1.4 Media WebSocket: frames in, input out

```
POST /api/rtc/whep  {"offer": "ws_mjpeg"}   (authed, JSON)
 -> data.answer   (opaque token, valid ~10 s; request it right before connecting)
```
If the device is not in MJPEG mode this returns `code: 1` with
`"called Whep with error: rpc error: code = Internal desc = Internal error"`.

Connect: `ws://<host>/ws/media?authorization=<encodeURIComponent(answer)>` with subprotocol
**`ws-media`**. Binary messages arriving are **one complete JPEG each** (starts `FF D8`).
Verified: 1920×1080, ~250 KB per frame, ~15–20 fps.

Send input on the same socket as binary messages: `[1 byte message type][protobuf body]`,
type `1` = keyboard, `2` = mouse (there is also `0` = client-begin; not needed).

Mouse message fields (protobuf, wire types per line):

| # | field | type | note |
| --- | --- | --- | --- |
| 1 | `mouse_type` | varint | 1 move, 2 down, 3 wheel, 4 up |
| 2 | `buttons` | varint | bit 1 = left, bit 2 = right; **always written**, `0` included |
| 3 | `absX` | double | normalized 0..1 of the frame |
| 4 | `absY` | double | normalized 0..1 |
| 5 | `relativeX` | double | 0 unless relative/pointer mode |
| 6 | `relativeY` | double | 0 unless relative/pointer mode |
| 7 | `verticalWheelDelta` | varint | sign only matters |
| 8 | `horizontalWheelDelta` | varint | sign only matters |

Keyboard message fields: `1 state` bool (`true` = down), `2 key` string (DOM `key`, e.g. `a`,
`Enter`), `3 code` string (DOM `code`, e.g. `KeyA`, `Enter`, `ShiftLeft`). The device maps
**`code`** to the Linux keycode; `key` is only a label.

A mouse move alone wakes a sleeping host — that is the documented way to wake it.

### 1.5 Paste (optional path, verify before relying on it)

`POST /api/paste {"text": "..."}` exists in the device UI (it rejects entries containing Chinese).
Its exact transport behaviour is unverified. Implement it in `linkr_type` only as a *fast path*
guarded by a self-test; when it fails, fall back to per-character key events.

---

## 2. Module contract: `lib/` (transport workstream)

Plain ESM, **Node built-ins only** (`node:crypto`, `node:http`, `node:https`, global `fetch`,
global `WebSocket` — Node ≥ 22). No npm dependencies: a linked bundle resolves from the profile's
workspace and cannot see the DSH installation.

`lib/index.js` re-exports the public surface:

```js
export { LinkrClient, LinkrError } from './client.js';
export { encodeKey, encodeMouse, keyEventsForText, parseCombo, KEY_TABLE } from './hid.js';
```

### 2.1 `linkr.js` — device HTTP client

```js
new LinkrDevice({ baseUrl, username, password, timeoutMs = 8000 })
  .origin                       // 'http://linkr.local' (trailing slash stripped)
  async login()                 // -> { token, username }; throws LinkrError
  async request(path, { method = 'GET', body, auth = true, timeoutMs } = {})
                                // -> unwrapped `data`; throws LinkrError
  async info()                  // GET /linkr/info (no auth) -> { deviceName, status, version, ... }
  async deviceInfo()            // /api/device/info
  async version()               // /api/device/version
  async videoMode()             // number
  async setVideoMode(mode)      // void
  async paste(text)             // POST /api/paste -> raw data or throws
  async whep(offer = 'ws_mjpeg')// -> { answer, streamId }
  dispose()                     // nothing to release today; keep for symmetry
```

`LinkrError extends Error` carries `status` (HTTP), `code` (business), `path` and a human
`sentence` (one line, no stack). 403 → `status: 403`; a WHEP-in-wrong-mode answer keeps the
device's own message so the caller can explain it.

### 2.2 `hid.js` — encoders, no I/O

```js
encodeMouse({ type, buttons = 0, x = 0, y = 0, dx = 0, dy = 0, wheelY = 0, wheelX = 0 }) -> Uint8Array
encodeKey({ key, code, down }) -> Uint8Array
keyEventsForText(text) -> Array<{ key, code, down }>   // US layout; down/up pairs in order
parseCombo('ctrl+shift+t') -> Array<{ key, code, down }>  // modifiers held, released last
KEY_TABLE: Record<string, { key: string, code: string }>  // Enter/Escape/Tab/F1../ArrowUp../ctrl/alt/shift/meta
```

Rules: double fields are written even when `0` (the mobile client does exactly that); `buttons`
is written even when `0`; ASCII only for text; unsupported characters throw a `LinkrError` whose
sentence names the offending character.

### 2.3 `media.js` — one media socket

```js
new MediaSession(device, { fps = 10 })
  async start({ timeoutMs = 12000 })  // whep + ws + first frame; throws on timeout
  stop()
  get open()                          // boolean
  get stats()                         // { frames, fps, lastFrameAt, width, height, mode }
  latest()                            // { seq, jpeg, width, height, at } | null
  async waitFrame({ after = 0, timeoutMs = 5000 })  // newest frame with seq > after
  onFrame(listener)                   // -> unsubscribe; called for every accepted frame
  sendMouse(message) / sendKey(event) // thin wrappers over send(Uint8Array)
  send(bytes)                         // throws when the socket is not open
```

### 2.4 `client.js` — the orchestration the Host uses (the only thing index.js touches)

```js
new LinkrClient({ baseUrl, username, password, manageVideoMode = true, fps = 10, idleStopMs = 120000 })
  configure(options)                 // apply a new config; drops the session if it was live
  get state()                        // plain JSON, see below
  async connect()                    // login (if needed) + ensure a live session
  async disconnect()                 // stop session, restore the device's video mode
  async probe()                      // device info WITHOUT touching video mode
  async capture({ timeoutMs = 6000 } = {})  // -> { jpeg, width, height, at, seq }
  async input(action)                // -> { applied: 'mouse'|'key'|'text', detail }
  onFrame(listener)                  // -> unsubscribe
  dispose()
```

`state` (JSON, no Buffers):

```js
{
  configured: boolean,
  origin: string,
  connected: boolean,        // a media socket is open
  device: null | { deviceName, status, version, model, sn, onlineTime },
  videoMode: number | null,  // device value right now, when known
  modeOwned: boolean,        // we changed it and owe a restore
  frames: number,
  fps: number,
  width: number,
  height: number,
  lastFrameAt: number,
  error: string,             // last failure sentence, '' when healthy
}
```

`input(action)` accepts, and nothing else:

```js
{ kind: 'mouse', action: 'move'|'click'|'double_click'|'right_click'|'scroll'|'drag',
  x, y,               // 0..1 normalized, required for all but scroll
  toX, toY,           // drag target
  wheelY, wheelX,     // scroll (lines; sign matters, magnitude is clamped to ±10)
  button }            // 'left'|'right' for drag, default left
{ kind: 'key', combo: 'ctrl+alt+t' }        // parseCombo, pressed in order, released in reverse
{ kind: 'text', text: '...' }               // paste fast path, else key events
```

Idle behaviour: `idleStopMs` after the last `capture`/`input`/`connect`, the session stops by
itself and restores the video mode. `connect()` (or any call) revives it. `disconnect()` stops now.

Concurrency: one session; concurrent `connect()` calls await the same start promise; `input` while
no session is a clear error ("no live session; call linkr_status/linkr_connect first").

### 2.5 Tests the transport workstream must deliver (`node --test test/`)

1. `hid`: golden byte vectors for a mouse move, a left click, a wheel, one key down and up —
   hand-computed hex, not "whatever the code prints".
2. `hid`: `keyEventsForText('Hi!')` ordering and modifier handling; a Chinese character throws.
3. `media`: against a local fake device (node:http + `ws`-free: use raw `node:http` upgrade or
   `new WebSocket` client only — the fake server may use `node:http` upgrade + manual framing, or
   simply serve a canned JPEG through a tiny hand-rolled 101 upgrade). The fake must also accept
   our binary frames and record them.
4. `client`: video-mode switch + restore, with a fake that records `POST /api/video/codec`
   (assert 1 then the original), a `capture()` that returns a JPEG, and an `input()` that reaches
   the socket as the expected bytes.
5. No test may touch the real device; a real-device smoke script may live in `test/smoke.mjs`
   and must be opt-in by env var `LINKR_SMOKE=1`.

`test/fake-device.mjs` should be reusable by the integration checks.

---

## 3. Host plugin contract: `index.js` (host workstream)

The Host half follows the idioms a DSH Host plugin uses: `defineTool`, `ctx.effect`, `sendJson`, a
cross-origin guard, a panel SSE channel and a `Config` standard-schema face. The skill references
listed at the bottom of this file document them.

```js
export const name = 'linkr'                 // row id in cordis.patch.yml is `linkr`
export const inject = ['tools', 'webServer']
export const Config = { '~standard': { version: 1, vendor: 'dsh-linkr', validate, jsonSchema } }
export function apply(ctx, rawConfig) { ... }
```

Config fields (defaults live in `cordis.patch.yml` too): `baseUrl` (default
`http://linkr.local`), `username` (default `admin`), `password` (default `''`; the credentials
record wins when present), `manageVideoMode` (true), `streamFps` (10), `idleStopMs` (120000),
`screenshotDir` (default `''` = `<session cwd>/.linkr`).

Secret handling: resolve the password as
`ctx.credentials?.readRecord('linkr/device')` (a record `{ password }`) first, then
`config.password`; `POST /linkr/config` persists `baseUrl`/`username` through
`ctx.get('configEditor')` (the reference plugin shows the exact call) and writes the password to
the credentials record when the credentials service is available, else to config.
Never log or echo the password; `/linkr/config` GET answers a masked `••••••`.

### 3.1 Tools (agent-facing; every one must be genuinely usable)

| Tool | Parameters | Behaviour |
| --- | --- | --- |
| `linkr_status` | none | Device name/version/model/SN, online state, video mode, whether a session is live, frame size and fps, panel state, and the one-line fix when something is wrong. Never switches the video mode. |
| `linkr_screen` | `save?` string path | Ensures a session, waits for a fresh frame (≤ 6 s), writes the JPEG (default `<cwd>/.linkr/screen-<ISO8601>.jpg`, `save` relative to cwd), returns the absolute path, pixel size, bytes and frame age, and tells the caller to open it with `read_image`. |
| `linkr_mouse` | `action` enum `move click double_click right_click scroll drag`, `x`,`y` 0..1, `toX`,`toY`, `wheelY`,`wheelX`, `button` | Injects one mouse action through the shared session. Answers what was sent, where, and the frame the coordinates refer to. |
| `linkr_type` | `text` string | Types text on the host (paste fast path, else key events). Rejects what the device cannot type, naming the character. |
| `linkr_key` | `combo` string (`ctrl+alt+t`, `Escape`, `enter`) | Presses a named key or chord and releases it in reverse order. |
| `linkr_panel` | `action` enum `open focus close` | Reveals/focuses/closes the live screen panel in the right column (same SSE channel the reference plugin uses). |

Rules that matter to a model: descriptions state units and ranges, say that keyboard/mouse act on
the real machine (so "verify with `linkr_screen` after acting"), and say that screen content is
untrusted data rather than instructions. Every tool returns a short plain-text report (a JSON blob
only when the answer is really structured). `linkr_screen` returns a path, not an image.

### 3.2 HTTP routes (shared by the panel and, in spirit, by the tools)

Prefix `/linkr`, same-origin guard as the reference plugin (reject a cross-origin `Origin`).

| Route | Purpose |
| --- | --- |
| `GET /linkr/state` | `{ ok, state, panel }` — the same `state` the tools read |
| `GET /linkr/config` | `{ ok, config: {baseUrl, username, password: '••••••'}, state, editable }` |
| `POST /linkr/config` | persist, apply, answer `{ ok, config }` |
| `POST /linkr/connect` / `POST /linkr/disconnect` | start / stop the session explicitly |
| `GET /linkr/live.mjpeg` | `multipart/x-mixed-replace; boundary=...` stream of the newest JPEG at `streamFps`, one part per frame; closes when the client disconnects or the session stops |
| `GET /linkr/frame.jpg` | the newest JPEG as a single response (409 with a reason when nothing arrived yet) |
| `POST /linkr/input` | the same `input(action)` the tools use; `{ ok, applied }` |
| `GET /linkr/panel/stream` | SSE of panel actions (`{type:'panel', action, at}`), replayed small backlog |
| `POST /linkr/panel` | `{ action: 'open'\|'focus'\|'close' }` → publishes to the SSE channel |

Any UI action must go through the same `LinkrClient` method the tool uses (one operation, two
callers). Do not keep a second input path.

### 3.3 Verification the host workstream must do itself

`node --check index.js`, then a local harness (`test/host-smoke.mjs`) that stands up a minimal
`ctx` stub (`tools.register`, `webServer.register`, `effect`, `get`) plus the fake device from the
transport workstream, applies the plugin, and drives every route and every tool through that stub.
Report exactly what passed.

---

## 4. Panel contract: `client.js` (panel workstream)

A right-column tab, exactly like the reference plugin's terminal tab:

- `window.__ModuleLoader__.load({ id: 'dsh-linkr', factory(require) { const React = require('react'); ... return { apply, inject, name } } })`
- `ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)`, `const t = ctx.locale.bind(NS)`
- `ctx.inject(['sidebarRightTabs', 'sidebarRight'], right => ...)`: register the tab type
  `right.sidebarRightTabs.register({ id: NS, kind: KIND, multiple: false, title, guide: [...] })`
  and the two slots `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title` keyed by `NS`.
- Panel actions from the Host (`open`/`focus`/`close`) arrive on `EventSource('/linkr/panel/stream')`.

The panel itself:

1. **Screen**: `<img src="/linkr/live.mjpeg?session=<nonce>">` filling the pane, `object-fit: contain`,
   dark letterbox, no CSS transforms that shift the content box. Reconnect with a new nonce when
   the stream ends (the `img.onerror` path) and show a plain "waiting for the first frame" line
   until `onload` fires.
2. **Input**: pointer events on the image map through the *rendered image content box* to 0..1
   (account for letterboxing), then `POST /linkr/input` — move (throttled ~30/s), click, double
   click, right click, wheel, drag (down at A, move, up at B). Keyboard: the pane is focusable
   (tabIndex 0, visible focus ring), keydown/keyup → `{kind:'key', combo}` per key with DOM
   `code`/`key`; send press and release separately; do not swallow the host's own shortcuts
   blindly — only capture keys while the pane has focus and call `preventDefault()` for the ones
   you send.
3. **Bar**: connection state (dot + text), device name, resolution, fps, 连接/断开, 刷新画面,
   适应宽度, 设置 (baseUrl/username/password form posting `/linkr/config`), and a short hint that
   the agent sees the same screen. Show a masked password and never echo it back.
4. **States**: not configured, connecting, live, session stopped (and why), device error.
   All copy through locale; every state has text, not just a colour.

Style: only `--dsw-alias-*` theme tokens (query `Theme`), invented class prefix `dsh-linkr-`,
sentence-case English, Chinese copy in `locale/zh.json`, English in `locale/en.json`
(`meta.title` / `meta.description` required in both). Reuse the host's control patterns
(buttons, inputs, switch) — do not import Harness Client packages.

Verification: `node --check client.js`, then install the bundle and check the live page
(right column → Linkr screen) in light and dark themes. Say explicitly what you could not verify
without a browser.

---

## 5. Facts already established (reuse; do not re-derive)

- `/tmp/probe/probe.mjs` — login + WHEP + WS + JPEG capture (works).
- `/tmp/probe/probe2.mjs` — sets mode 1, captures a 1920×1080 JPEG to
  `/tmp/probe/frame.jpg`, sends a 23-byte mouse move, restores mode 0 (works).
- Credentials for a real device are supplied out-of-band, never in this file; never write them
  into a tracked file, a test, or a log line.
- Environment: Node v22.22.3, DSH 0.2.1-rc.5, profile `web`, workspace: this checkout. Install with `plugin_manager install_bundle`.

## 6. Read these before coding

- Skill references bundled with the Harness installation
  (`dsh-agent-preset/skills/cordis-plugin-development/`) →
  `references/host-plugin.md`, `references/ui-plugin.md`, `references/practices.md`,
  `references/user-actions.md`, `references/verification.md`.
- Client protocol source of truth: the device itself at fw 1.6.0/1.7.0 (login, WHEP, `ws/media`,
  the control socket), observed directly against the hardware.

---

## 7. Round 2 — frame rate and real codecs (2026-11-06)

Measured on the real device (fw 1.6.0, 1920×1080 host), all after login:

| Path | Source offer | Device mode | Measured |
| --- | --- | --- | --- |
| MJPEG over WS | `ws_mjpeg` | 1 | ~37 fps, ~319 KB per JPEG frame |
| H.264 over WS | `ws_h264` | 2 | ~52 packets/s, AnnexB (`00 00 00 01 67 42 c0 28…`), payload 1.6–128 KB |
| H.265 | — | 3 | **not offered**: `ws_h264` (and any WS offer) is refused in mode 3 with the firmware's `rpc Internal error`; H.265 is only reachable over WebRTC |

So: MJPEG is limited by our own `streamFps` throttle, H.264 is available and much cheaper on the
LAN, and H.265 is reachable only over WebRTC (out of scope for a Node host; would need a browser
WebRTC decode path in the panel and would make the agent depend on an open panel).

### 7.1 ws-media frame format (verified against the device's WebSocket media stream)

Binary message = 25-byte header + payload:

```
byte 0        uint8   mediaType (1 = video, 2 = audio)
bytes 1..8    int64   ptsUs      (big endian)
bytes 9..16   uint64  durationUs (big endian)
bytes 17..24  uint64  payloadSize (big endian, must equal length - 25)
bytes 25..    payload — H.264 AnnexB access unit for ws_h264, raw JPEG for ws_mjpeg
```

### 7.2 H.264 → JPEG decode (proven recipe)

```
ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay \
       -f h264 -i pipe:0 -an -f image2pipe -vcodec mjpeg -q:v 4 pipe:1
```

Pipe every video payload into stdin; split stdout on `FF D8 … FF D9` into complete JPEG frames.
Measured with this recipe: **55.8 decoded JPEG fps** from a 52.5 packets/s source, ~310 KB per
frame. After the frame is decoded, everything downstream is unchanged (`latest`/`waitFrame`/`onFrame`,
the panel's multipart route, `linkr_screen`, `linkr_input` — input still rides the same socket).

ffmpeg discovery order: config `ffmpegPath` → `$FFMPEG_PATH` → `/opt/homebrew/bin/ffmpeg` →
`ffmpeg` on PATH. Missing ffmpeg must degrade to MJPEG with a sentence, never a crash.

### 7.3 Config and state additions

- `codec`: `'auto' | 'mjpeg' | 'h264'` (default `auto` = h264 when ffmpeg is available, else mjpeg).
- `ffmpegPath`: string, default `''`.
- `jpegQuality`: number 1..10 (default 4, ffmpeg `-q:v`; ignored on the MJPEG path).
- `streamFps`: default **20**, range 1..30 (the old default 10 was the whole "low frame rate" story).
- Device mode mapping: mjpeg → 1, h264 → 2; the session must still remember and restore the
  device's original value on stop/dispose.
- `/linkr/state` gains `codec` (`'mjpeg' | 'h264'`) and `decoder` (`'ffmpeg' | null`).

### 7.4 Invariants that must survive this round

- One `LinkrClient` per plugin instance; tools, routes and panel keep sharing one session.
- The explicit-stop behaviour of round 1 (409 while stopped, `state.stopped`) is unchanged.
- The panel keeps consuming `multipart/x-mixed-replace` JPEGs — no `<video>` element, no WebRTC,
  no second media socket. Only the source codec below the `onFrame` pipeline changes.
- Dispose kills ffmpeg; no orphan child, no wedged device mode.

---

## 8. Round 3 — the panel becomes a "computer" card (2026-11-06)

Decision from the user, after a reference screenshot of another product's right-column "电脑" tab:
**small state shows our live KVM desktop; "放大" swaps in the device's own full console in an
iframe; "打开 Linkr" opens that console in a new tab.** The agent tools and the host routes do not
change — this is a presentation change in `client.js` plus locale copy.

- Tab title `电脑` (en `Computer`); the start-page guide card is titled `Linkr 共享电脑`
  (en `Linkr shared computer`), described as the shared machine's picture plus the Linkr console.
- Card header: title on the left; `放大` / `还原` and `打开 Linkr` on the right. `打开 Linkr`
  opens `${state.origin}/` with `window.open(..., '_blank', 'noopener')` and is disabled while the
  origin is unknown.
- Default body: today's `<img src="/linkr/live.mjpeg?session=…">` stage, unchanged, plus a hint
  line under it: 缩小状态只显示桌面；点「放大」使用 Linkr 完整控制台。若小窗无法显示，请打开 Linkr。
  (en: "The small view shows only the desktop; click Expand for the full Linkr console. If the
  small view cannot render, open Linkr instead.")
- Enlarged body: `<iframe src="${state.origin}/" referrerpolicy="no-referrer">` filling the pane,
  with one line of copy under it: 登录与设备管理请在 Linkr 控制台内完成。 (en: "Sign-in and device
  settings happen inside the Linkr console."). While enlarged the live picture is **paused** (no
  `<img>`, no retry, no stream request) so the device is released — returning to the small view
  re-arms the stream through `connectNow()`; a stopped session stays stopped.
- The compact metrics line (`Linkr-… · H.264 · 1920×1080 · 24 fps`) and the 连接/断开、刷新画面、
  设置 controls stay available in the header area, one row, without wrapping into a second block.
- The device sends no `X-Frame-Options` / `frame-ancestors`, so the iframe is allowed (verified
  against fw 1.6.0). Note in the copy that the console is cross-origin and its own login applies.

---

## 9. Round 4 — no enlarge mode (2026-11-06)

The user removed the enlarge/console mode after seeing it: **the panel is the picture, and only the
picture.** Delete `放大` / `还原`, the iframe body, and the enlarged-mode branch; the tab stays
`电脑` with the `Linkr 共享电脑` card.

- `打开 Linkr` stays: `window.open(state.origin + '/', '_blank', 'noopener')`, disabled while the
  origin is unknown. It is the only way into the device console from the panel now.
- One hint line under the picture replaces both old ones:
  共享电脑的实时画面；登录与设备管理请在「打开 Linkr」里进行。
  (en: "The shared computer's live picture. Sign in and change device settings in Open Linkr.")
- Delete the `expand`, `restore` and `consoleHint` locale keys; `viewHint` keeps its name with the
  new copy. Everything else (codec line, 连接/断开, 刷新画面, 适应宽度, 设置, stopped machine,
  retry gate) is unchanged, and the picture is never paused for a console.

---

## 10. Round 5 — settings must expose the codec (2026-11-06)

The panel's settings form (the ⚙ disclosure, `POST /linkr/config`) currently edits only
`baseUrl` / `username` / `password`. The user needs to change the encoding there, without touching
the profile file.

- Add to the form, below the connection fields:
  - **编码格式 / Encoding** — a select with `auto` (自动：能解码就用 H.264), `mjpeg`, `h264`,
    binding `config.codec`.
  - **帧率 / Frame rate** — integer 1–30, binding `config.streamFps`.
  - **JPEG 质量 / JPEG quality** — integer 1–10, binding `config.jpegQuality`, with the note that it
    only affects the H.264 path (`-q:v`).
  - **ffmpeg 路径 / ffmpeg path** — optional text, empty = auto-detect, binding `config.ffmpegPath`.
- The Host accepts all four through `POST /linkr/config` (verified) and answers the new values; a
  config write restarts the plugin, so after a successful save the panel must re-read state, call
  `POST /linkr/connect` and re-arm the stream with a new nonce (the existing save flow already
  connects; extend it so a codec change shows the new `codec` in the metrics line).
- Validate client-side (enum, 1–30, 1–10) and show the Host's message when it rejects; never send
  the masked password back, and keep the password field empty when unchanged.
- The metrics line keeps showing the **effective** codec from `state.codec` (not the setting), so the
  user can see auto → h264 or the mjpeg fallback.

---

## 11. Round 6 — the picture sits right under the controls, top-aligned (2026-11-06)

Reference: the user's screenshot of the other product's "电脑" tab — control rows first, then the
picture, then the hint, then empty space; the picture is top-aligned and as wide as the column, it
is **not** centred inside a full-height dark stage.

- Pane layout (top → bottom, top-aligned, no vertical centring): title + `打开 Linkr` → status and
  `codec · resolution · fps` → 连接/断开、刷新画面、适应宽度、设置 → picture → hints → empty space.
- `.dsh-linkr-stage` no longer grows (`flex: 0 0 auto`), `align-items: flex-start`, horizontal
  centring only; its dark background covers just the picture block.
- Default picture `width: 100%; height: auto; display: block`. Fit mode constrains height to the
  pane (`max-height: 100%`), keeps top alignment, scrolls if it still overflows.
- Pointer mapping, focus ring, crosshair, overlays/pills, the stopped machine, the codec line and
  the settings form are untouched — this is sizing and alignment only.

---

## 12. Round 7 — the panel's empty space shows the agent's Linkr activity (2026-11-06)

The user wants the blank area under the picture to show what the agent (and the panel) has been
doing with the device: `linkr_screen` captures, clicks and keys, text, connects/disconnects, codec
changes, fallbacks, errors.

### 12.1 Host: one bounded ring, published on the existing SSE channel

- Keep the newest **100** entries in memory (per applied plugin, cleared on reload):
  `{ at: <epoch ms>, source: 'agent' | 'panel' | 'host', action: string, detail: string, ok: boolean }`.
  `action` is a short verb bucket — `linkr_screen`, `linkr_mouse`, `linkr_key`, `linkr_type`,
  `linkr_panel`, `linkr_status`, `connect`, `disconnect`, `config`, `session`, `device`, `error`.
  `detail` is one short human line (no secrets, no password, no base64): e.g.
  `click 0.40, 0.30 (left)`, `Escape`, `14 chars`, `1920×1080 → screen-….jpg`,
  `h264 via ffmpeg, mode 2`, `device not reachable: …`.
- Record from: every tool `execute` (source `agent`, ok/failed with the sentence on failure), every
  mutating route (`/linkr/input` → `panel`, `connect`/`disconnect`/`config` → `panel`), and host
  lifecycle (`session` started/stopped/idle-restored, `device` codec fallback `notice`, `error`).
- Publish each new entry on the **existing** `GET /linkr/panel/stream` SSE as
  `{"type":"log","entry":{…}}`; on connect replay the last **50** entries as `type: "log"`
  records before live ones, in oldest→newest order. Existing `{"type":"panel",…}` records keep
  their shape and order.
- Also answer `GET /linkr/log?since=<epoch ms>` with `{ ok: true, entries: [...], at: <now> }`
  (`since` omitted = the whole ring), so a reader that missed the stream can catch up.
- Never log the password, the token, or frame bytes.

### 12.2 Panel: a log under the picture

- Below the hints, in the leftover space: a section titled `最近活动` / `Recent activity`, a
  scrollable list (max-height fills the rest of the pane, `min-height: 0`), newest first, newest
  **100**, one row per entry: `HH:MM:SS` + action + detail; failed entries in the error tone with
  the detail as the tooltip. Empty state: `还没有调用记录` / "No Linkr activity yet."
- Feed it from the panel SSE (`type: "log"`), and once on mount from `GET /linkr/log` so a fresh
  page has history. Dedupe on `at + action + detail`; tolerate an older Host without log records
  (then the section shows the empty state, no errors).
- Do not change the picture, the header, the settings form or the stopped machine.

---

## 13. Round 8 — quick paste, and a log about what the AGENT did (2026-11-06)

Two user requests: a quick-paste control in the panel, and the activity list must show **how the
agent operated the computer**, not what the person clicked.

### 13.1 Host: only agent operations reach the ring

- Stop recording `source: 'panel'` entries entirely: `/linkr/input`, `/linkr/connect`,
  `/linkr/disconnect`, `/linkr/config`, `/linkr/panel` no longer append to the ring. A person's
  clicks, keys and connects are theirs, not the agent's.
- Keep `source: 'agent'` (the six tools) and `source: 'host'` (session started/idle-stop,
  codec-fallback `device`, `stream:`/`frame:` errors) — those describe what happened to the device.
- Every agent entry carries a small `params` object next to `detail`, so the panel can phrase the
  operation in the user's language instead of echoing an English verb:
  - `linkr_screen` `{ width, height, file }`
  - `linkr_mouse` `{ action, x, y, toX?, toY?, button?, wheelY?, wheelX? }` (numbers 0..1 as sent)
  - `linkr_key` `{ combo }`
  - `linkr_type` `{ chars }`
  - `linkr_panel` `{ panelAction }`
  - `linkr_status` `{ deviceName, codec, fps, live }`
  - failures keep `ok: false`, `detail` = the sentence, `params` may be `{}`.
- `detail` stays as today (the English one-liner) for older readers and for `/linkr/log` consumers;
  `params` is additive.
- The SSE record shape stays `{"type":"log","entry":{…}}`; `/linkr/log` keeps `{ok, entries, at}`.

### 13.2 Panel: quick paste + agent-phrased rows

- **快捷粘贴** — a `粘贴` / Paste control in the header row with 刷新画面/适应宽度/设置. Clicking it
  tries `navigator.clipboard.readText()`; on success it posts `{kind:'text', text}` to
  `POST /linkr/input` and shows the outcome in the status line. If the clipboard API is missing,
  denied, or returns empty, it opens a small inline popover with a textarea + `发送` / Send (the
  same POST), so paste still works in a shell that refuses clipboard reads. Esc closes the popover;
  the popover never sends an empty string.
- **Rows** — phrase known `params` in the locale, falling back to `detail` when `params` is absent
  or unrecognised:
  - screen `截屏 1920×1080` / `Capture 1920×1080`
  - mouse `点击 (42%, 31%)` · `双击` · `右键` · `移动到 (x%, y%)` · `滚动 上 3` / `下 3` ·
    `拖拽 (20%, 20%) → (80%, 80%)`
  - key `按 Ctrl+Alt+T`; type `输入 14 个字符`; panel `打开/聚焦/关闭面板`; status `查看状态`
  - host rows keep `detail` (English) with their localized action label.
- Keep the `最近活动` section otherwise unchanged (100 rows, newest first, SSE + one `/linkr/log`
  read, dedupe, error tone). Human actions no longer appear because the Host no longer records them.

---

## 14. Round 9 — one computer-use-style tool with inline screenshots (2026-11-06)

The user wants the Linkr host driven through the computer-use vocabulary instead of four bespoke
tools, and a capture should reach the model **without** a second `read_image` round trip.

### 14.1 Attachments (how a tool returns an image)

Verified against the installed services:

```js
const ref = await ctx.get('attachments').saveImage({ data: jpeg, mediaType: 'image/jpeg', name })
// ImageAttachmentRef = { attachmentId, mediaType, bytes, width, height, name?, originalDimensions? }
// model-facing content block: { type: 'image', attachment: ref }
```

`saveImage` validates and may normalize (downscale) the raster; respect `attachments.imageLimits`
(`maxImageBytes`, `maxImagePixels`, `maxImageDimension`). When `ctx.get('attachments')` is missing,
fall back to text + path only. `render()` may return `[{ type: 'text', … }, { type: 'image', attachment }]`
and the value it receives is JSON, so the ref travels in the tool's JSON value.

### 14.2 Tool: `linkr_computer_use` replaces four tools

Delete `linkr_screen`, `linkr_mouse`, `linkr_type`, `linkr_key`; keep `linkr_status` and
`linkr_panel`. Register one tool `linkr_computer_use`:

| Parameter | Meaning |
| --- | --- |
| `action` (required) | `capture`, `click`, `double_click`, `right_click`, `drag`, `scroll`, `type`, `key`, `wait` |
| `coordinate` | `[x, y]` in **pixels of the captured frame** (the size `capture` reports); optional for capture/type/key/wait |
| `from_coordinate`, `to_coordinate` | drag endpoints, pixels |
| `direction`, `amount` | scroll: `up`/`down`/`left`/`right`, ticks (default 3) |
| `text` | type |
| `keys` | key: `ctrl+alt+t`, `return`, `escape`, `tab`, `space`, `backspace`, `up`…, `cmd`/`ctrl` aliases |
| `seconds` | wait (0–30) |
| `capture_after` | boolean; every action may return a follow-up capture |
| `save` | capture only: file path (relative to the session working directory; default `<session>/.linkr/capture-<ISO>.jpg`) |

Behaviour: every action first ensures a session (like `capture()`); pixel coordinates are divided by
the current frame width/height (reject out-of-range with a sentence naming the frame size);
`click` = down+up at the point; `drag` = down at from, move, up at to; `type` stays ASCII-only with
the existing refusal sentence; `key` presses the chord and releases in reverse; `wait` just sleeps.
The result value is `{ ok, action, width, height, path?, image?, frameAgeMs }`; the rendered content
is one short text line plus, for `capture` and any `capture_after`, the image block. Keep the file on
disk too (the path is what a person can open).

Logging (CONTRACT §13): map each action onto the existing buckets so the panel's phrasing keeps
working — `capture`→`linkr_screen` `{width,height,file}`, pointer actions→`linkr_mouse` with the
same params as today, `type`→`linkr_type` `{chars}`, `key`→`linkr_key` `{combo}`.

---

## 15. Round 10 — clipboard paste and read-back (Linkrd)

ASCII typing goes through the HID keyboard, so it cannot produce Chinese or other non-ASCII text.
The device can, however, hand text to a **Linkrd** plugin running on the controlled machine and then
paste it with the host's own shortcut. That is the only path for Unicode, and it is now part of the
computer-use tool:

- `linkr_computer_use` gains two actions:
  - `paste` — put text on the controlled machine's clipboard, then press `ctrl+v` (a terminal needs
    `ctrl+shift+v`; `keys: ""` only writes the clipboard). One clipboard write, atomic, instead of
    one key event per character. Needs Linkrd on the controlled machine.
  - `clipboard` — read the controlled machine's clipboard back as text (bounded; cheaper and exact
    compared with reading the screen).
- Routes: `GET /linkr/clipboard` (cached availability probe, never carries text) and
  `POST /linkr/clipboard` (write text, press the paste keys).
- The panel shows whether Linkrd's clipboard is available and offers a paste-into-clipboard action;
  the ASCII quick paste from round 8 is unchanged.
- `type` stays ASCII-only with the existing refusal sentence; `paste` is the Unicode path.
- Activity log: `paste` → `linkr_paste`, `clipboard` → `linkr_clipboard`.

## 16. The device control WebSocket and the Linkrd clipboard

`ws/media` carries video and HID input; the clipboard lives on the device's **control** socket
`/ws`, with no subprotocol and the token inside every message (not in the handshake):

```
WsMessage { 1 MessageType, 2 Token, 3 MessageCode int64, 4 Message,
            5 PingReq, 6 PongReply, 42 ClipboardStatusReq, 43 ClipboardStatusReply,
            44 ClipboardTextReq, 45 ClipboardTextReply }
ClipboardStatusReply { 1 Enabled bool, 2 Connected bool, 3 Session string,
                       4 Revision uint64, 5 HasText bool, 6 Text string, 7 MaxTextBytes uint32 }
ClipboardTextReq     { 1 RequestId string, 2 Session string, 3 Revision uint64, 4 Text string }
ClipboardTextReply   { 1 RequestId string, 3 Revision uint64 }
```

`Revision` is a monotonic uint64 and must never pass through a JS Number: it arrives as a decimal
string and is compared as BigInt. One connection per device, one request in flight; the session and
revision come from the status reply and are echoed in the text request.

Protocol source: the device's control socket at fw 1.7.0 (observed). The envelope in `lib/control.js` is
hand-rolled — it covers only these bodies, not a protobuf runtime.

## 17. Round 11 — the Linkrd install guide

Typing Unicode needs a plugin the user has to install **on the controlled machine**, and nothing in
the panel said so. The panel now carries one piece of onboarding, and the agent carries the same
message in its refusals. This round documents that guide; it changes no route and no tool
behaviour beyond the sentence a refusal returns.

- **Panel card.** `LinkrLinkrdGuide` sits between the hint line and 最近活动: title, one paragraph,
  three benefits (Chinese/multi-line text, read-back, file drop through `Linkrd.img`), the three
  install steps (install + enable in the device console's Plugin center → mount `Linkrd.img` →
  run the Linkrd program on the controlled machine), and the note that the panel's own keyboard path
  stays US-ASCII. Its only action is **打开 Linkr 安装** (`window.open(state.origin + '/')`,
  disabled while the origin is unknown) — the guide never gates a session, a capture or a paste.
- **Dismissal is a browser preference.** `localStorage['dsh-linkr.linkrd-guide']` is `'hidden'` after
  不再提示 and `'open'` otherwise; a storage-less shell just sees the card again instead of failing.
  Settings (`⚙`) has a **Linkrd 安装指引** row that reopens it, so the choice is reversible.
- **When it opens on its own.** First visit (unless the preference says hidden), a clipboard probe
  answering `disabled` or `disconnected`, and any failed paste or clipboard write. The probe's other
  reasons (`unconfigured`, `device-error`, `unsupported`) are not Linkrd's fault and stay a status
  line, not a guide.
- **Copy lives in four places** — the `zh` and `en` dictionaries inside `client.js` plus
  `locale/zh.json` and `locale/en.json`. `test/locale.test.mjs` pins key parity between the locale
  files and the client dictionary, because a key added to one and forgotten in another ships as a
  blank row rather than as a build error.
- **The agent says the same thing.** `lib/hid.js` appends the Linkrd path to the US-ASCII refusal
  (`… the device keyboard is US-ASCII only (for Chinese or other Unicode text, install Linkrd on the
  controlled machine and paste it through its clipboard)`), and `host/tools.js` describes `paste`
  as the Unicode path and tells the model to point the reader at the panel's guide instead of
  retrying a refused `type`.
- **Not claimed.** The guide does not detect the installed program on the controlled machine; the
  only evidence the plugin has is the clipboard probe's answer, which is why the card is advice and
  the status line is the fact.


---

## 17. Round 11 — transport source moves to repository-level `core/` (A2)

The transport (`client.js`, `control.js`, `ffmpeg.js`, `hid.js`, `linkr.js`, `media.js`, `index.js`)
now lives in the repository-level `core/` and is shared by the plugin and the MCP server. The plugin
must still ship a self-contained package, so `scripts/sync-core.mjs` materializes the source into
`dsh-linkr/lib/` before tests, before the Codex bundle build and before `npm pack`:

- `dsh-linkr/lib/` is **generated, gitignored**; never edit it by hand.
- Imports inside the plugin are unchanged (`host/client.js` → `../lib/index.js`); consumers outside
  the package (`mcp-linkr`, the Codex bundle) reference the materialized directory, and
  `scripts/build-codex-plugin.mjs` copies it into the bundle runtime.
- `node scripts/sync-core.mjs --check` fails on a stale or partial copy; `npm test` runs the sync
  first and `scripts/pack-smoke.mjs` packs the plugin, extracts the tarball outside the repository,
  asserts the seven transport modules are byte-identical to `core/`, and imports the packaged entry
  point — a packaged file that reached outside its own package would fail there.

## 18. Codex follows the compact DSH status and Linkrd guide (0.3.1)

The Codex panel follows DSH changes `0f953f7` and `b27f88b`: clipboard unavailability sits beside
the connection state, its reason remains in the tooltip/accessibility label, stopped pictures
omit repeated connection advice, and the optional Linkrd guide uses the shortened benefits and
`Linkrd.img` steps. Codex retains its own login form and explicit human-takeover gate.

The private loopback `clipboard.json` endpoint probes only an already-live client, coalesces
requests and caches the capability for five seconds. Only `available` and a known reason code
leave the transport; clipboard text, raw device messages and tokens are excluded. The response
carries the device revision so an old probe cannot label a new session. Stopping or changing
settings invalidates an outstanding result without reconnecting the device. The UI probes at
most once per ten seconds while visible and live; unknown/working capabilities add no chrome.


Video-mode recovery is shared between the two harnesses since `fb06e8b`'s follow-up: the journal
(`stateDirectory()`/`journalPath()`/`writeJournal()`/`clearJournal()`), the stale-owner rules and
the HTTP restore moved from `mcp-linkr/device-mode.js` to `core/journal.js` and `core/recover.js`,
which `scripts/sync-core.mjs` materializes into `dsh-linkr/lib/` and the MCP server imports. Both
`LinkrClient` users pass the same hooks: write `{pid, instance?, origin, baselineMode, mode, at}`
before a mode switch, clear after the restore. The MCP server keeps its cross-process lease around
the restore; the DSH Host instead repairs a leftover journal before it builds the first client of
an apply, allowing the same pid (Cordis reloads the plugin in place) and skipping the work when
`manageVideoMode` is false. `core/recover.js` refuses a journal whose owner pid is alive, verifies
the device reports the restored mode, and clears the record; a dead-owner record without a finite
baseline is discarded. `dsh-linkr/test/recovery.test.mjs` covers the hook and the same-pid repair.

Settings writes are ordered so a failure cannot leave half a change: the row
(`baseUrl`/account/codec/pace/…) is saved through `configEditor` first, then the
password is stored in the credentials record. If the profile write fails, no
credential write happens; if the credential write fails after the row was
saved, the previous values of the changed keys are written back through the
editor before the error is returned. A store failure that also resists the
rollback reports that the other settings were saved. Covered by host-smoke
("a failed password store rolls the saved row back", "a failed profile write
never touches the password store").

`LinkrClient.dispose()` is idempotent: concurrent or repeated calls share one
teardown, report the session end at most once (and not at all when there was no
session and no mode debt), and retry a video-mode restore that failed earlier.
`session-end.test.mjs` covers dispose idempotency, disconnect-after-dispose, and
an idle stop whose restore fails before a later dispose heals it.


The media socket carries its identity in its handlers: a 'message' or 'close'
from a WebSocket that is no longer the session's current `#ws` is ignored. This
matters when `stop()` followed by `start()` replaces the socket before the old
socket's asynchronous close event arrives; the late event used to clear the new
`#ws` and kill the new session (and its ffmpeg child). `media-race.test.mjs`
drives the interleaving with a stub WebSocket.

Clipboard control requests are serialised at channel entry: one in-flight request
per control socket (a second caller gets the existing "busy" sentence). The
previous head-check only looked at `#pending`, which was set after awaiting the
socket/token, so two concurrent callers could both send a frame and confuse the
single reply slot. `control.test.mjs` asserts the second call is refused and only
one frame reaches the device.

The H.264 decode path bounds its input: when ffmpeg's stdin reports backpressure,
`MediaSession` drops further ws-media packets until 'drain' and counts them in
`stats.dropped` (live video is disposable; ffmpeg resynchronises at the next
keyframe). The previous code wrote every packet and let Node buffer without
limit. `decoder-backpressure.test.mjs` stalls the decoder with a fake ffmpeg that
never reads stdin and asserts packets were dropped.
