# Codex Linkr

## Platform

Web UI inside a local desktop MCP App. The existing runtime is Node.js 22+ and uses the
shared Linkr transport; this work preserves that runtime and the DSH integration.

## Users and purpose

The user wants to watch the controlled computer in the conversation's side panel while Codex
operates it through a Linkr KVM. The controlled computer is a different, real machine.

## Confirmed behavior

- A live screen beside the conversation, sharing the agent's device/media connection.
- The user explicitly chose passive viewing by default, with mouse, scrolling, and keyboard
  input available only after actively enabling human takeover.
- Agent input pauses during human takeover. Stopping restores the video mode and stays stopped.
- Device credentials stay in the local runtime and are not embedded in the app or plugin package.
- The user supplied the DSH Linkr panel and settings screenshots as the visual reference, and
  requested device login inside this plugin. Address, account, password, and video settings
  belong in that form; saved passwords do not round-trip back to the UI or MCP tools.

## Scope

Local plugin development and verification. Public release and account publication are not requested.
