# Codex Linkr desktop panel verification

Date: 2026-11-09. Local plugin: `codex-linkr@linkr-local`, version `0.3.1`.

## Verified

- All 13 suites in `scripts/test-all.mjs`, including packaging and the official MCP SDK client.
  This includes 84 shared transport tests, 51 host smoke checks, seven MCP session/panel
  regressions, six private login/device-switching regressions, and two TOML
  policy-preservation tests.
- SIGKILL between the mode write and first frame remains recoverable; cancelled queued
  input is not sent; concurrent processes cannot change an owned device's mode.
- Human takeover pauses agent input; Stop restores the mode and blocks implicit restart.
- A long agent wait does not block the panel preview, takeover heartbeat, or release.
- The browser host simulator decodes real JPEGs from the fake device and verifies passive
  viewing, click, keyboard, wheel, drag, Escape, Stop, and the MCP preview fallback.
  It also covers wrong-password errors, login by Enter and button, blank-password
  settings updates/reconnect, text sending by Enter and button, and logout. The sandbox
  intentionally omits `allow-forms`; both flows use explicit handlers rather than native
  form navigation. Nineteen HID packets reached the fake device; page errors: zero.
- DSH-reference screen and settings layouts were visually checked at widths 390, 768,
  and 1440, including light and dark themes. The full-width image keeps its aspect ratio.
  The dynamic image is mounted only after it has a source, fixing the previous
  missing-image detector warning without a suppression.
- The panel follows DSH commits `0f953f7` and `b27f88b`: a compact clipboard-unavailable
  label beside the connection state, no repeated stopped-picture advice, and a shorter
  optional Linkrd guide using `Linkrd.img`. Browser regression checks unavailable/available
  states, tooltip reasons and the stopped picture. The capability endpoint coalesces/caches
  probes, strips copied text and tokens, and discards responses from a stopped session.
- The source HTML template's `flat-type-hierarchy` finding has a file-scoped exception
  in `.impeccable/config.json`. Its stylesheet is injected at runtime; the source-only
  scan reports default 16px sizes. Rendered body/title sizes are 13/14px by design,
  matching the compact DSH reference with weight, spacing and section boundaries.
  Other rules and other files remain checked.
- Passwords do not enter MCP tool arguments/results or GET settings responses. Login
  requires a separate private write capability; persisted config/secret files are mode
  0600. Failed authentication preserves the previous session, Stop interrupts pending
  login, switching devices requires a new password and fresh capture, and logout removes
  the managed secret and prevents automatic reconnect. Persistence across MCP restarts
  is covered by the private login suite.
- Codex CLI `0.166.0` installs the package. The real Codex app-server discovers five tools,
  `ui://linkr/screen/v0.3.1`, and the `thread` entrypoint with no discovery error. The versioned
  resource avoids reusing the previous UI cache.
- Installed files match the inspected, self-contained 26-file build. No device credentials
  are bundled. The implementation uses the [official thread entrypoint contract](https://developers.openai.com/plugins/build/extensions).

## Acceptance still pending

- The running conversation has not loaded the newly installed plugin tools; restart/reload
  the desktop host and open a plugin-enabled conversation to verify the actual side panel.
- Real-device acceptance still requires signing in with the intended device address and
  account in the plugin's Settings view. No password-file preparation or chat disclosure
  is required. This run used a fake device, so real video and real keyboard/mouse input
  are not claimed as tested. Two-factor accounts remain unsupported by the shared transport.

## Reproduce

```sh
MCP_SDK_DIR=/path/to/node_modules node scripts/test-all.mjs
PLAYWRIGHT_MODULE_DIR=/path/to/node_modules node scripts/panel-browser-smoke.mjs
node scripts/build-codex-plugin.mjs
codex plugin marketplace add ./build
codex plugin add codex-linkr@linkr-local
```

Browser screenshots are under `build/panel-verification/` and visibly identify the fake device.
