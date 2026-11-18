# harness-linkr — instructions for coding agents

This file is for agents **working on this repository**. If you are an agent that only *uses* the
Linkr tools from a harness, read that harness's folder instead (`codex/AGENTS.md`,
`opencode/AGENTS.md`, `mimocode/AGENTS.md`, `minimaxcode/AGENTS.md`) — those are meant to be copied
into a harness's own instructions, not followed while editing this repo.

## Generated files — never edit by hand

| Path | What it is |
| --- | --- |
| `dsh-linkr/lib/` | **Generated** from `core/` by `scripts/sync-core.mjs`. Gitignored, not tracked. |
| `build/` | Build output (`scripts/build-codex-plugin.mjs`), gitignored. |
| `**/node_modules/`, `.linkr/`, `.impeccable/` | Local artifacts, gitignored. |

To change the transport (login, WHEP, MJPEG/H.264, ffmpeg, HID frames, Linkrd clipboard,
`LinkrClient`): edit `core/*.js` and then **materialize**:

```sh
npm run sync          # node scripts/sync-core.mjs
npm test              # also runs the sync first, then every suite
```

`git status` must never list anything under `dsh-linkr/lib/`. If it does, something wrote a
generated file into git — undo that instead of committing it.

**Fresh clone:** run `npm run sync` once **before** installing the DSH plugin from the directory or
starting `mcp-linkr`, otherwise the packaged copy of the transport is missing. `npm test` performs
it automatically.

## Where things live

```
core/                 transport source of truth (shared by every package)
dsh-linkr/            DeepSeek Harness plugin: host/{config,activity,client,routes,tools}.js,
                      client.js (right-column panel), index.js (wiring only)
mcp-linkr/            MCP stdio server: tools.js, config.js, device-mode.js, device-lease.js,
                      panel.js + panel/, settings.js
codex/ opencode/ mimocode/ minimaxcode/   adapter configs + user-facing AGENTS.md
scripts/              setup, doctor, test-all, sync-core, pack-smoke, docs-check, parity-check,
                      mcp-compliance, build-codex-plugin
docs/                 DESIGN/CONTRACT of the transport, MCP compliance and end-to-end evidence
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | sync + all suites (dsh unit/host smoke, mcp stdio/journal/session-safety/settings, setup, parity, doctor, docs, packaging, SDK compliance when installed) |
| `npm run sync` | materialize `core/` into `dsh-linkr/lib/` |
| `npm run pack` | packaging smoke: `npm pack`, unpack outside the repo, import the packaged entry |
| `npm run doctor` | read-only environment/device self-check (`--fix` for the two safe repairs) |
| `npm run setup` | write a harness's MCP config (see `README.md`) |
| `node scripts/build-codex-plugin.mjs` | build the self-contained Codex local plugin under `build/` |

Node ≥ 22. The shipped packages have **no npm dependencies** (Node built-ins only). Use
`node --test test/*.test.mjs`; `node --test test/` is broken on Node 22/24 (it runs the directory as
a module).

## Rules that keep this repo safe and correct

- **Never leave the device changed.** A session switches the device's global `video_codec`; it must
  be restored on every exit path (there is a journal for unclean shutdowns). Tests use the fake
  device from `dsh-linkr/test/fake-device.mjs`; anything touching the real device is opt-in
  (`LINKR_SMOKE=1`, `--real`) and must not leave a session or decoder running.
- **No secrets.** Passwords arrive through `LINKR_*` environment variables or files; never write a
  device password, token, or a copied credentials file into the repository, docs, logs or tests.
- **`npm test` must stay green** for every change; add a case to the matching suite rather than
  relying on manual checks. A packaged plugin must remain self-contained — `pack-smoke` fails on a
  file that reaches outside its package.
- **Describe the protocol as observed behaviour.** Do not name, link or quote the device's
  proprietary web-console/client sources in code, tests or docs; the field numbers are the wire
  contract, verified against the device. `docs-check` rejects any mention of that console's code
  or repository name.
- **Keep the two faces in sync.** `dsh-linkr` (DSH plugin) and `mcp-linkr` (MCP) expose the same
  computer-use vocabulary; `scripts/parity-check.mjs` fails when they drift.
- **Docs are checked.** `scripts/docs-check.mjs` fails when a documented path, adapter example,
  action list, or safety rule is missing — update docs with the code.
- **Append, don't rewrite history:** `dsh-linkr/docs/CONTRACT.md` is the append-only build journal.
  Add a new numbered section for a design decision instead of editing old ones.
- Commit focused changes with a message that explains the behaviour, not the file list.
