# Changelog

All notable changes to this plugin. The build journal with the measured protocol facts and the
per-round acceptance criteria is in [`docs/CONTRACT.md`](docs/CONTRACT.md).

## 0.1.0 — 2026-11-06

First working version, verified against a Radxa Linkr at `linkr.local` (fw 1.6.0) with a
1920×1080 Linux host behind it.

### Device control

- Login with the salted SHA-256 password, Bearer token, one automatic re-login on 403, rate-limit
  backoff.
- MJPEG over the device media WebSocket (one JPEG per message) and **H.264** over the same socket
  (ws-media packets decoded through one ffmpeg child into JPEG frames), with automatic fallback to
  MJPEG when no decoder is available or decoding fails.
- The device's global `video_codec` is switched for a session and **always restored** afterwards
  (idle stop, explicit stop, error, dispose).
- Mouse and keyboard injection as `[type][protobuf]` frames on the media socket: move, click,
  double click, right click, drag, scroll, chords such as `ctrl+alt+t`, ASCII text typing.
- **Clipboard** through the device control WebSocket and Linkrd on the controlled machine: paste
  Unicode text (`ctrl+v` / `ctrl+shift+v`) and read the machine's clipboard back.

### Agent-facing surface

- `linkr_computer_use` — one computer-use-style tool (`capture`, `click`, `double_click`,
  `right_click`, `drag`, `scroll`, `type`, `key`, `wait`, `paste`, `clipboard`, `capture_after`) with
  pixel coordinates of the captured frame; captures come back inline as image blocks, so no extra
  `read_image` trip.
- `linkr_status` (read-only device/session report) and `linkr_panel` (open/focus/close the panel).
- Activity log of agent operations (bounded, password-redacted, SSE + `/linkr/log`).

### Panel

- Right-column 「电脑」 tab: live picture with pointer and keyboard, codec · resolution · fps line,
  connect/disconnect, refresh, fit, settings (device address, account, encoding, frame rate, JPEG
  quality, ffmpeg path), quick paste (clipboard with a textarea fallback), 打开 Linkr, and the
  agent activity list.
- Explicit stop is sticky: the panel will not revive a session that was released.

### Quality

- 69 transport unit tests, 48 Host smoke cases, opt-in real-device smoke.
- GPL-3.0-only.
