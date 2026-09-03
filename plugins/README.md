# Plugins

Plugins that put a running coding-agent session on the wire, so something other than the
terminal in front of you can watch it and answer its permission prompts.

| Plugin | Harness | What it does |
|---|---|---|
| [`claude-code/`](claude-code) | Claude Code | `PreToolUse` hook becomes the HCP permission channel |

The plugin ships as a bundled **MCP server**, so Claude Code starts it with the plugin and
stops it with the session. Nothing runs in the background that you have to manage.

This directory is also a **Claude Code marketplace** — the manifest is at
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) in the repo root.

---

## Getting started

### Requirements

**Node 22.6 or newer on your `PATH`.** This is the one thing that trips people up. The MCP
server is a `.ts` file run directly using Node's native type stripping; on older Node it
fails to start, the hooks get connection errors, and Claude Code treats those as
non-blocking — your session keeps working, the plugin just silently does nothing.

```bash
node --version    # must be v22.6.0 or higher
```

### 1. Install

From GitHub:

```bash
claude plugin marketplace add michaljach/hcp
claude plugin install hcp@hcp
```

Or from a local checkout, which is what you want if you plan to change anything:

```bash
git clone https://github.com/michaljach/hcp
claude plugin install ./hcp/plugins/claude-code
```

Restart your session, or run `/reload-plugins`.

### 2. Confirm it loaded

```
/mcp
```

There should be a server named `hcp`, connected. Then:

```
/hcp
```

which reports what is attached and whether anything is waiting on a decision. On a fresh
install it will say no client is attached — that is correct, and it means the plugin is
deliberately doing nothing yet.

### 3. Attach a client

**On your phone (same Wi-Fi):** set the plugin's `bind` option to `lan` with
`/plugin config hcp`, restart the session, then run `/hcp` and open the URL it prints —
including the `#t=` fragment, which is the capability token. You get a live feed,
permission buttons, and a prompt box. Nothing is exposed until you opt in to `lan`, and
every request needs the token.

**In a terminal:**

The repo ships a minimal one that stands in for a phone:

```bash
node plugins/claude-code/test/client.ts
```

It attaches to every registered session and prints events as they happen:

```
attaching to abc123 (idle)
  live   #1 user_message: add a migration for the users table
  state -> working
  live   #2 tool_call
```

### 4. Watch a permission cross the wire

In your Claude Code session, ask for something that grades `medium` or higher — installing a
dependency, a `git push`, anything touching migrations. The prompt appears **in the client**
instead of your terminal:

```
  HIGH RISK — Run database migrations: npm run migrate:dev
  allow_once / reject_once / reject_feedback
  type an option id (then optional text) and press enter:
```

Type:

```
reject_feedback Use staging, not dev
```

Claude receives the denial *with the reason*, which is the difference between blocking an
agent and redirecting one.

### 5. Send a prompt back

Type anything that is not an option id and it is queued as a prompt:

```
also add an index on users.email
  queued (1 pending) — delivered when the current turn ends
```

It lands the moment Claude finishes its current turn. If the session is idle nothing is
coming to interrupt, so it waits for the end of the next turn you start locally.

---

## How it decides what to escalate

The plugin stays out of the way by default. `PreToolUse` returns **no decision** — letting
Claude Code's normal permission flow run exactly as if the plugin were not installed — in
three cases:

1. **No client is attached.** Nobody is watching remotely, so nothing should change.
2. **The risk is below the escalation floor.** Default `medium`. You do not want a
   notification about `git status`.
3. **The request expired** unanswered after 110 seconds. A client that fell asleep must not
   silently block the agent.

To change the floor:

```bash
/plugin config hcp
```

Set `escalate_from` to `low` to route everything, or `high` for destructive operations only.

---

## Troubleshooting

**Nothing reaches the client.** Almost always one of: Node is older than 22.6; no client is
attached; or the action graded below `escalate_from`. Check in that order.

**`/mcp` does not list `hcp`.** The server failed to start. Run it by hand to see why:
`node plugins/claude-code/src/server.ts` — a Node version error shows up immediately.

**Prompts still appear in my terminal.** That is the design when nothing is attached, and it
is also what happens on every failure path. The plugin is built so it cannot wedge a local
session; a silent fallback to normal behavior is the intended failure mode.

**`/mcp` shows `hcp` connected but the client says ENOENT.** The running server predates
the socket-path fix in 0.2.1. Disable and re-enable the plugin so it restarts on the new
path. Server and client both derive the socket from `$TMPDIR/hcp-<uid>/hcp.sock` now —
earlier builds used `CLAUDE_PLUGIN_DATA`, which is only set for processes Claude Code
launches, so a client started from a shell could never find it.

**Port 7517 is in use.** The hooks POST to a fixed port because `hooks.json` is static config
and cannot read a runtime value. If something else owns it, the server retries the bind every
30 seconds and takes over when the port frees. To move it you must set `HCP_HOOK_PORT` *and*
edit the URLs in `hooks.json` to match.

**Approvals feel slow.** The server answers at 110s and `hooks.json` gives up at 120s,
ordered so the server decides rather than the clock. If you are hitting those, nothing is
attached to answer.

---

## Limits worth knowing before you rely on it

- **Same network only.** The phone client works over your LAN, guarded by a capability
  token, over plain HTTP with no TLS. There is no NAT traversal, so nothing works over
  cellular — that is HCP's `relay://` transport, specified in
  [`spec/v0.1/`](../spec/v0.1) but unbuilt, and it needs a rendezvous server someone has
  to host. The Ed25519 device pairing the spec asks for is also not implemented; a bearer
  token stands in for it.
- **Prompts land at turn end, not immediately.** `session/prompt` queues your text and
  delivers it by blocking the next `Stop` event. That steers work already in flight, but it
  **cannot wake an idle session** — with no turn running, no `Stop` is coming. For prompts
  that start turns, use [`claude-code-adapter`](../examples/claude-code-adapter), which
  drives the CLI from outside.
- **Draft protocol.** HCP v0.1 is a draft and will change.

## Writing another one

`plugins/claude-code` is about 600 lines and most of it is not Claude-specific. The parts
worth copying are `src/server.ts` (sessions, `seq` log, client fan-out) and `src/classify.ts`
(risk grading), both of which are harness-independent — the
[Codex adapter](../examples/codex-adapter) demonstrates that by reusing the equivalent files
byte-for-byte. What you actually write per harness is the hook wiring and the payload mapping.

Start from [`docs/adapter-mapping.md`](../docs/adapter-mapping.md).
