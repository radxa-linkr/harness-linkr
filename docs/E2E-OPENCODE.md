# End-to-end evidence: OpenCode → Linkr MCP server → real device

Device names, addresses and serials in these records are redacted (`admin` / `linkr.local` are placeholders).

Date: 2026-11-08. Harness: `opencode 1.18.35`. Model: `opencode/deepseek-v4.1-flash-free`
(OpenCode's free tier, so this run spent nothing). Device: Radxa Linkr at `http://linkr.local`,
fw 1.6.0, 1920×1080 host.

The project lived in a throwaway directory with only a project-level `opencode.json` (written by
`scripts/setup.mjs`); the user's global OpenCode configuration was not modified.

## Command

```sh
cd /tmp/opencode-e2e        # opencode.json from scripts/setup.mjs, LINKR_* env inside it
opencode run -m opencode/deepseek-v4.1-flash-free \
  'Use the linkr MCP tools. Call linkr_status first, then linkr_computer_use with action=capture.
   Reply with exactly two lines: DEVICE=<deviceName> and FRAME=<width>x<height>.
   Do not run shell commands.'
```

## What OpenCode reported

```
> build · deepseek-v4.1-flash-free
⚙ linkr_linkr_status Unknown
⚙ linkr_linkr_computer_use {"action":"capture"}
DEVICE=admin
FRAME=1920x1080
```

Both tools were invoked by the model through OpenCode's own MCP client, against the real device; the
capture was also written to `~/.linkr/captures/capture-2026-11-08T03-15-25-490Z.jpg`. The first tool
row shows `Unknown` only because OpenCode has no display metadata for that call, not because it
failed — the second call consumed the first one's answer (`capture` needs no arguments).

After the run the device was restored to `video_codec: 0` and no decoder process remained.
