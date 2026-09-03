---
description: Show HCP daemon status, registered sessions, and pending remote approvals
allowed-tools: Bash(node *)
---

Run the HCP status command and report what it says:

!`node "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" status`

Summarize for the user:

- Whether the daemon is up, and where its client socket is.
- Each registered session with its state, and call out any in `awaiting_input` — those
  are blocked waiting for a decision from a connected client.
- If nothing is attached, mention that tool calls fall through to the normal local
  permission flow, so the plugin is doing nothing until a client connects.

Do not attempt to answer a pending permission yourself. Those exist to be answered by a
remote client, and answering locally would defeat the point.
