# End-to-end evidence: Codex → Linkr MCP server → real device

Device names, addresses and serials in these records are redacted (`admin` / `linkr.local` are placeholders).

Date: 2026-11-08. Harness: `codex-cli 0.166.0` (model `gpt-6.1-terra`, provider `openai`).
Device: Radxa Linkr at `http://linkr.local`, fw 1.6.0, 1920×1080 host.

This records the original CLI capture run. The newer desktop panel is covered separately by
the fake-device browser and MCP session-safety suites; those are not real desktop-host acceptance.
Recovery now runs under a device lease on the first connection, rather than during MCP initialize.

The test ran Codex with a throwaway `CODEX_HOME` (auth copied in, config written by
`scripts/setup.mjs`), so the user's real Codex configuration was not modified.

## Command

```sh
CODEX_HOME=/tmp/codex-e2e/codex-home codex exec \
  --skip-git-repo-check --approve-for-me \
  -C /tmp/codex-e2e/work -o /tmp/codex-e2e/answer2.txt \
  'Use the Linkr MCP tools (names start with mcp__linkr__). Call linkr_status first,
   then linkr_computer_use with action="capture". Reply with exactly two lines:
   DEVICE=<deviceName from the status answer> and FRAME=<width>x<height> from the capture.'
```

## What Codex reported

```
approval: on-request
sandbox: workspace-write [workdir, /tmp, $TMPDIR]
mcp: linkr/linkr_status started
mcp: linkr/linkr_status (completed)
mcp: linkr/linkr_computer_use started
mcp: linkr/linkr_computer_use (completed)
DEVICE=admin
FRAME=1920x1080
tokens used 18,172
```

Both tools were invoked by the model through the harness's own MCP client, against the real device;
the capture was also written to `~/.linkr/captures/capture-<ISO>.jpg` (278 KB).

## Things the run exposed (fixed)

1. **Approval policy.** Codex refuses MCP tool calls when the policy is `never`
   (`MCP tool call requires approval, but approval policy is never`). A non-interactive run needs
   `--approve-for-me` (or an interactive session where the user approves).
2. **Abrupt kills strand the device mode.** Codex kills the MCP server when the run ends instead of
   closing stdin, so the server could not restore the device's `video_codec`. The server now
   journals `{origin, pid, baselineMode}` before switching and `--restore-mode` (also run at every
   server start) heals a journal whose owner is gone. Covered by the stdio smoke test (SIGKILL →
   mode stranded → `--restore-mode` → restored) and by `mcp-linkr/test/device-mode.test.mjs`.

After the run the device was restored to `video_codec: 0` and no decoder process remained.
