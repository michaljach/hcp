---
description: Show which HCP clients are attached and whether anything is waiting on a remote approval
---

Call the `hcp_status` tool from the `hcp` MCP server and report what it says.

Summarize for the user:

- Whether any client is attached. If none is, say plainly that the plugin is doing
  nothing right now — tool calls fall through to the normal local permission prompt.
- Each registered session with its state, calling out anything in `awaiting_input`,
  which means a tool call is blocked waiting on a decision from a connected client.
- The escalation floor, since that determines what gets sent to a client at all.

Do not try to answer a pending permission yourself. Those exist to be answered by a
remote client, and answering locally would defeat the point.
