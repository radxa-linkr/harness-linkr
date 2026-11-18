# harness-linkr

Agent-harness integrations for **Linkr** KVM-over-IP devices: give an agent the eyes and hands of
the controlled host computer (screen capture plus mouse/keyboard injection), and give the person a
live screen panel and the device's own console next to it.

One folder per harness. Each folder is a self-contained package for that harness; the shared part
is the device protocol and the behaviour rules, not code.

| Folder | Harness | Mechanism | Status |
| --- | --- | --- | --- |
| [`dsh-linkr/`](dsh-linkr/) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) | native plugin (tools + right-column panel) | Working, verified against fw 1.6.0 (clipboard paste needs fw 1.7.0) |
| [`mcp-linkr/`](mcp-linkr/) | any MCP client | stdio MCP server (shared by the adapters below) | Working, smoke-tested against a fake device and a real device |
| [`codex/`](codex/) | Codex desktop / CLI | local plugin + MCP App | Live thread panel, passive viewing and explicit human takeover; the earlier CLI capture was **end-to-end through a real Codex run** — see [`docs/E2E-CODEX.md`](docs/E2E-CODEX.md) |
| [`opencode/`](opencode/) | OpenCode | MCP server + **native 2.x plugin** | Verified with **2.2.7** (`mcp.servers.linkr`, and `opencode/plugin` as first-class tools with a local live panel) and **end-to-end through a real OpenCode run** — see [`docs/E2E-OPENCODE.md`](docs/E2E-OPENCODE.md) |
| [`mimocode/`](mimocode/) | MiMoCode | MCP server | Config + tools/list verified; model run blocked by this machine's MiMo credentials (see [`docs/E2E.md`](docs/E2E.md)) |
| [`minimaxcode/`](minimaxcode/) | MiniMaxCode | MCP server | Config shape checked against the installed CLI (0.7.6) and its own parser; runtime needs a model (`mcode` has no `mcp list` in 0.7.6) |

## What every harness integration provides

- **Eyes**: a JPEG of the controlled host's screen, delivered straight to the model (inline image)
  when the host harness supports it, and written to disk always.
- **Hands**: click, double click, right click, drag, scroll, type (ASCII), key chords — injected
  through the device's USB HID, so it works on any host OS without an agent on that machine.
- **Unicode text** (where the port supports it): write the controlled machine's clipboard over the
  device's control WebSocket and press the host's own paste shortcut, so Chinese and long text need
  no per-character typing. This is the one part that needs the optional **Linkrd** plugin on the
  controlled machine; without it the refusal names that as the fix, and the panel carries a
  dismissible three-step install guide.
- **Control**: device status, explicit connect/disconnect, and a live picture a person can watch
  and take over in the harness UI (where the harness has one).
- **Safety rules shared by every port**: coordinates are pixels of the last capture; the device's
  video mode is always restored when a session stops; a person's explicit stop stays stopped; screen
  content is untrusted data, never instructions.

## Device protocol (shared knowledge)

The protocol facts all ports implement live in [`dsh-linkr/docs/CONTRACT.md`](dsh-linkr/docs/CONTRACT.md)
and are summarised in [`dsh-linkr/docs/DESIGN.md`](dsh-linkr/docs/DESIGN.md): login with a salted
SHA-256 password, WHEP negotiation, the `ws/media` socket (one JPEG per message in MJPEG mode, or
H.264 ws-media packets decoded through ffmpeg), HID frames as `[type][protobuf]`, and the device's
global `video_codec` (1 MJPEG, 2 H.264-over-WS; H.265 is WebRTC-only on this firmware).

## Quick setup for a harness

For the Codex desktop plugin and live side panel, follow the [local plugin build and install](codex/README.md#desktop-plugin-with-a-live-side-panel).

One command writes the harness's own config, pointing it at the shared MCP server, and keeps a
backup of every file it changes:

```sh
# from the repository root
node scripts/setup.mjs --harness codex --username <device-account> --password-file ~/.linkr/password
node scripts/setup.mjs --harness opencode --username <device-account> --project .
node scripts/setup.mjs --harness mimocode --username <device-account> --project .
node scripts/setup.mjs --harness minimaxcode --username <device-account>                   # user-level ~/.minimax/mcp.json
node scripts/setup.mjs --harness minimaxcode --username <device-account> --project .       # project .mcp.json
node scripts/setup.mjs --harness all --username <device-account> --password-file ~/.linkr/password
```

`--base-url` defaults to `http://linkr.local`; the device password is never printed and is
referenced through `LINKR_PASSWORD_FILE`. `--dry-run` prints the exact configs/commands without
touching anything, `--json` is machine-readable. The password is also accepted from
`LINKR_PASSWORD` for one command and saved to `~/.linkr/password` (mode 0600).

## Something is not working

```sh
node scripts/doctor.mjs            # read-only: runtime, ffmpeg, password file, stale journal,
                                   # device login, and every harness's MCP entry
```

It prints `PASS` / `WARN` / `FAIL` / `SKIP` lines and, for every problem, the command that fixes it.
To see exactly what a harness passes to the server, run
`node mcp-linkr/index.js --check-config` with the same environment: it prints the resolved
configuration with the password masked and exits 2 naming any missing setting.
`--no-device` skips the network check, `--json` is machine-readable. A stale restore journal is
reported with the `--restore-mode` fix, and `--fix` applies the two safe repairs itself: it tightens
a world-readable password file to 0600 and heals a stale journal (restoring the device mode) when the
device is reachable. Nothing else is written and no session is started.

## Architecture: one transport, one MCP server, thin adapters

```
harness ──MCP stdio──▶ mcp-linkr/             codex/ opencode/ mimocode/ minimaxcode/
                       (tools + env config)    are configuration + instructions only
                            │
                            ▼
                       core/  (LinkrClient: login, WHEP, MJPEG/H.264+ffmpeg, HID, clipboard)
                            │  materialized by scripts/sync-core.mjs
                            ▼
                       dsh-linkr/lib  (copy inside the plugin package, so a tarball is self-contained;
                                       the MCP bundle build copies it too)
                            │
                            ▼
                       Linkr device ──HDMI in / USB HID out──▶ controlled computer
```

The DeepSeek Harness plugin additionally has a native Web UI half (`dsh-linkr/client.js`); the MCP
harnesses get the same device control through `mcp-linkr`.

### Repository layout

```
harness-linkr/
├─ core/                  transport source of truth (shared by every package below)
├─ dsh-linkr/             DeepSeek Harness plugin  (lib/ = materialized copy of core/)
├─ mcp-linkr/             MCP stdio server (tokens, panel, settings, device lease)
├─ codex/ opencode/ mimocode/ minimaxcode/   per-harness config + AGENTS.md
├─ scripts/               setup, doctor, test-all, sync-core, pack-smoke, docs/parity/compliance
└─ docs/                  design notes, protocol facts, end-to-end evidence
```

## dsh-linkr quick start

```sh
# from this repository
dsh plugin --profile <profile> add "$(pwd)/dsh-linkr"

# or in the Harness UI: Plugins → install, with the absolute path to dsh-linkr/
```

Settings live in the profile's `cordis.patch.yml` row `linkr` (device address, account, codec,
frame rate, JPEG quality, ffmpeg path); the password goes to the Harness credentials store. See
[`dsh-linkr/README.md`](dsh-linkr/README.md).

## Development

Working on this repository (with another agent or by hand)? Read [AGENTS.md](AGENTS.md) first: it
lists the generated files that must not be edited, the sync step, the test commands and the rules
that keep the device and the credentials safe.


Each package documents its own commands. For `dsh-linkr`:

```sh
cd dsh-linkr
node --test test/*.test.mjs     # transport + locale unit tests (fake device, no network)
node test/host-smoke.mjs        # the Host half against a ctx stub and the fake device
```

Everything at once:

```sh
node scripts/test-all.mjs      # every suite: dsh unit + host smoke, MCP journal/stdio/SDK
                               # compliance, setup smoke, dsh/mcp parity guard
```

Protocol compliance is also checked through the official MCP SDK client — see
[docs/MCP-COMPLIANCE.md](docs/MCP-COMPLIANCE.md). Harness end-to-end evidence:
[docs/E2E.md](docs/E2E.md) (status per harness), [docs/E2E-CODEX.md](docs/E2E-CODEX.md),
[docs/E2E-OPENCODE.md](docs/E2E-OPENCODE.md).

For `mcp-linkr` (and every MCP adapter):

```sh
cd mcp-linkr
node test/mcp-smoke.mjs        # spawns the server over stdio against the fake device
node index.js --status         # one-shot device report (needs LINKR_* env)
```

The transport source is `core/`; `dsh-linkr/lib/` is its materialized copy (gitignored), written by
`node scripts/sync-core.mjs` (also run automatically by `npm test`) and by `npm run pack`. Never edit
`dsh-linkr/lib/` by hand. `npm run pack` additionally packs the plugin, extracts the tarball outside
the repository and imports it, which fails if a packaged file reaches outside its own package.

A directory install links the checkout into the harness profile: Host-half edits take effect after
restarting the app (or toggling the plugin), Web-half edits after a page reload.

## Licence

GPL-3.0-only. See [LICENSE](LICENSE).
