# Plugins

Plugins that put a running coding-agent session on the wire, so something other than the
terminal in front of you can watch it and answer its permission prompts.

| Plugin | Harness | What it does |
|---|---|---|
| [`claude-code/`](claude-code) | Claude Code | `PreToolUse` hook becomes the HCP permission channel |

This directory is also a **Claude Code marketplace** — the manifest is at
[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) in the repo root.

---

## Getting started

### Requirements

**Node 22.6 or newer on your `PATH`.** This is the one thing that trips people up. The hooks
execute `.ts` files directly using Node's native type stripping; on older Node the hook exits
non-zero, and Claude Code treats that as a non-blocking error — your session keeps working,
the plugin just silently does nothing.

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
/hcp
```

You should see the daemon's status and any registered sessions. On a fresh install it will
say the daemon is not running — that is correct. It starts on the next `SessionStart`, so
open a new session and try again.

### 3. Attach a client

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

**`/hcp` says the daemon is not running.** It starts on `SessionStart`. Open a new session.
If it still does not appear, the daemon writes a log next to its sockets — `/hcp` prints the
socket directory.

**Prompts still appear in my terminal.** That is the design when nothing is attached, and it
is also what happens on every failure path. The plugin is built so it cannot wedge a local
session; a silent fallback to normal behavior is the intended failure mode.

**Approvals feel slow.** The daemon answers at 110s, the hook gives up at 118s, and
`hooks.json` kills it at 120s — ordered so the daemon decides rather than the clock. If you
are hitting those, nothing is attached to answer.

---

## Limits worth knowing before you rely on it

- **Local only.** The daemon listens on unix sockets in a `0700` directory. HCP's `ws://`
  and `relay://` transports, pairing, and the Noise channel are specified in
  [`spec/v0.1/`](../spec/v0.1) but not implemented, so there is no safe way to reach this
  from a real phone over a network yet.
- **It cannot originate turns.** A hook can observe and it can decide, but it cannot inject
  a new turn into a running CLI, so `session/prompt` and `session/steer` return `-32005`.
  The [`claude-code-adapter`](../examples/claude-code-adapter) exists for that case: it
  drives the CLI from outside and can start turns.
- **Draft protocol.** HCP v0.1 is a draft and will change.

## Writing another one

`plugins/claude-code` is about 700 lines and most of it is not Claude-specific. The parts
worth copying are `src/daemon.ts` (sessions, `seq` log, client fan-out) and `src/classify.ts`
(risk grading), both of which are harness-independent — the
[Codex adapter](../examples/codex-adapter) demonstrates that by reusing the equivalent files
byte-for-byte. What you actually write per harness is the hook wiring and the payload mapping.

Start from [`docs/adapter-mapping.md`](../docs/adapter-mapping.md).
