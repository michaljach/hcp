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
- The phone URL the tool prints, verbatim including the `#t=` fragment — that fragment
  is the capability token and the link does not work without it. If the server is bound
  to loopback, say that the URL will not work from a phone until the plugin's `bind`
  option is set to "lan" and the session restarts.

Do not try to answer a pending permission yourself. Those exist to be answered by a
remote client, and answering locally would defeat the point.
