# Harness verification status

Device names, addresses and serials in these records are redacted (`admin` / `linkr.local` are placeholders).

What has been proven, on which harness, and what is still blocked by the environment rather than by
the code. The device in every check was a Radxa Linkr at `http://linkr.local` (fw 1.6.0) with a
1920×1080 host behind it.

| Harness | Config recognised by the CLI | Tools discovered | Real model run | Detail |
| --- | --- | --- | --- | --- |
| DeepSeek Harness | yes (plugin) | yes | yes | right-column panel + agent tools verified since the first round |
| Codex 0.166.0 | yes (`codex mcp list`) | yes (during the run) | **yes** — `DEVICE=admin`, `FRAME=1920x1080` | [E2E-CODEX.md](E2E-CODEX.md) · [adapter](../codex/README.md) |
| OpenCode 2.2.7 | yes (`opencode --standalone debug config` shows `mcp.servers.linkr`) | yes (`tools/list` observed) | **yes** — `DEVICE=admin`, `FRAME=1920x1080` | [E2E-OPENCODE.md](E2E-OPENCODE.md) · [adapter](../opencode/README.md) |
| MiMoCode 0.1.15 | yes (`mimo mcp list` → connected) | yes (`tools/list` observed) | **blocked** — `Invalid API Key` from this machine's MiMo credentials | below · [adapter](../mimocode/README.md) |
| MiniMaxCode 0.7.6 | config shape checked against the CLI's parser | n/a (no `mcp list` in 0.7.6) | **blocked** — CLI not installed here | [../minimaxcode/README.md](../minimaxcode/README.md) |

Protocol-level evidence for the shared server itself: `mcp-linkr/test/mcp-smoke.mjs` (hand-written
MCP client), `scripts/mcp-compliance.mjs` (official SDK client) and the real-device runs above.

## MiMoCode attempt (2026-11-08)

```sh
cd /tmp/mimo-e2e                                   # mimocode.json from scripts/setup.mjs
mimo mcp list                                      # ● ✓ linkr connected opencode:/tmp/mimo-e2e/mimocode.json
mimo run -m xiaomi/mimo-v2.6-flash "Use the linkr MCP tools. Call linkr_status first, …"
# Error: Invalid API Key: Please provide valid API Key
```

`mimo providers list` shows one stored "Xiaomi Token Plan (China)" credential, while
`mimo providers whoami` reports "Not logged in" — the credential on this machine is not usable. The
server side needed no change: the harness connected to it, listed the tools and started the run; it
stopped at the provider. Once `mimo auth login` has been run, the same command is the e2e check (the
adapter README documents it).

## How to finish the blocked rows

- **MiMoCode**: `mimo auth login`, then `mimo run -m <model> "call linkr_status and capture"`.
- **MiniMaxCode**: `npm i -g @minimax-ai/code`, log in, then `mcode run …` from a project whose
  `.mcp.json` (or user-level `mcp.json`) was written by
  `node scripts/setup.mjs --harness minimaxcode --username <account>`.


## Kill-mid-session recovery (2026-11-19, fake device)

`node scripts/recovery-e2e.mjs` starts a local fake device plus an MCP server, captures once
(switching the fake's codec 0 → 1 and writing `~/.linkr/mcp-session-<origin>.json` with baseline 0),
SIGKILLs the server, then runs `mcp-linkr/index.js --restore-mode`:

```
baseline codec: 0
after capture codec: 1 | journal: 0
after SIGKILL codec: 1 | journal exists: true
restore exit: 0 | stdout: {"recovered":true,"mode":0}
after recovery codec: 0 | journal exists: false
```

The same journal/restore path is used by the DSH plugin (`dsh-linkr/test/recovery.test.mjs` covers
its hooks and the in-process reload case). The suite runs in `node scripts/test-all.mjs`.
