# `hcp` — Claude Code plugin

Exposes the Claude Code session you are *already sitting in* over HCP v0.1, so a phone,
a browser, or another harness can watch it and answer its permission prompts.

```
claude session ──http hooks──▶ MCP server ──unix socket──▶ client (phone)
                               (this plugin)                     │
      PreToolUse blocks ───────────┘                             │
      permissionDecision ◀───────────── first answer wins ───────┘
```

The server is the plugin's **bundled MCP server**, so Claude Code starts it when the
plugin is enabled and stops it with the session. Nothing here spawns or supervises a
background process.

`claude plugin validate` passes; `npm test` runs 18 end-to-end checks through the real
hook entry point and the real sockets.

## Why this and not the adapter

This repo has two Claude Code implementations, and the difference is architectural.

| | [`claude-code-adapter`](../../examples/claude-code-adapter) | this plugin |
|---|---|---|
| Relationship to the CLI | **Spawns** `claude` and drives stream-json | **Lives inside** a session you started |
| Permission channel | `control_request` over stdio | `PreToolUse` hook |
| Can originate turns | Yes — `session/prompt` works | No; a hook cannot inject a turn |
| Sees the real session | No, a session it created | Yes, the one you are working in |
| Install | none, just run it | `/plugin install` |

Use the adapter to build a remote client that owns its sessions. Use the plugin when you
want to hand off the session already in front of you.

## Install

```bash
claude plugin install ./plugins/claude-code               # from a checkout
```

Needs Node 22.6+ on `PATH` — the hooks run `.ts` files directly via native type stripping.

## How it works

`hooks/hooks.json` points six events at `http://127.0.0.1:7517/hook`. There is no hook
script — the hooks are pure configuration, and the server answers them directly:

| Event | What it does |
|---|---|
| `SessionStart` | Registers this session with the server |
| `UserPromptSubmit` | Emits a `user_message` event, state → `working` |
| `PreToolUse` | **The permission channel.** Classifies, escalates, blocks on the answer |
| `PostToolUse` | Emits `tool_result` |
| `Stop` | State → `idle` |
| `SessionEnd` | State → `ended`, deregisters |

### Why HTTP hooks and not `mcp_tool`

Claude Code offers an `mcp_tool` hook type that would call the bundled server directly,
and it is the obvious thing to reach for. It does not work here: `mcp_tool` hook results
are **side-effect only** — read like command-hook stdout, with no support for
`permissionDecision`. They cannot block a tool call.

`type: "http"` hooks can. They POST the entire hook payload and their response body is
parsed for the full set of decision fields. So the permission channel is HTTP, and MCP is
what gets the process started and keeps it alive.

### One process, three surfaces

| Surface | Spoken to by | Carries |
|---|---|---|
| stdio | Claude Code | MCP. One tool, `hcp_status` |
| `127.0.0.1:7517` | this plugin's hooks | Hook events, and the permission decision back |
| unix socket | HCP clients | HCP v0.1 |

The port is fixed because `hooks.json` is static config and cannot read a value chosen at
runtime. Every session's hooks POST to the same port, so whichever server owns it serves
every session on the machine — which is what makes `host/sessions/list` mean anything. A
server that loses the bind retries, so if the owner exits another takes over.

### Staying out of the way

`PreToolUse` returns **no decision** — letting Claude Code's normal permission flow run
exactly as if the plugin were not installed — in three cases:

1. **No client is attached.** Nobody is watching remotely, so nothing should change.
2. **The risk is below the escalation floor.** Default `medium`, configurable as
   `escalate_from`. You do not want your phone buzzing about `git status`.
3. **The request expired** with no answer after 110s. A client that fell asleep must not
   silently block the agent — it hands back to the local prompt.

Every failure path returns `{}` the same way, and if the server is not listening at all
the hook is a non-blocking error, which Claude Code already treats as "carry on". A
remote-control plugin that can wedge a local session is worse than no plugin.

### Timeout chain

Deliberately ordered so the server decides rather than the clock: the server answers at
**110s** and `hooks.json` gives up at **120s**.

## Try it

In one terminal, start a Claude Code session with the plugin enabled. In another:

```bash
node test/client.ts
```

It attaches to every registered session and prints events live. Ask Claude to do something
that grades `medium` or higher — `npm install`, a `git push`, anything touching migrations
— and the prompt appears in the client instead of your terminal:

```
  HIGH RISK — Run database migrations: npm run migrate:dev
  allow_once / reject_once / reject_feedback
  type an option id (then optional text) and press enter:
```

Type `reject_feedback Use staging, not dev` and Claude receives the denial *with the
reason*, which is the difference between blocking an agent and redirecting one.

`/hcp` inside a session calls the `hcp_status` tool and reports what is attached and what
is waiting.

## What it cannot do

**Originate turns.** `session/prompt` and `session/steer` return `-32005`. A hook can
observe and it can decide, but it cannot inject a new turn into a running CLI. This is the
one real cost of living inside the session instead of driving it, and it is why the adapter
still exists.

Also not implemented, all of it specified in the spec and none of it here: `ws://` and
`relay://` transports (the HTTP port is loopback-only and carries hooks, not HCP), pairing
and the Noise channel, leases, push, `fs/*` and `terminal/*`.

## Note

`src/classify.ts` and `src/types.ts` are byte-identical copies of the adapter's. Plugins
must be installable standalone, so they cannot reach outside the plugin root — the test
asserts the copies have not drifted rather than letting them quietly diverge.

`PreToolUse` is the documented, stable hook, so that is what this uses. Claude Code also
fires a `PermissionRequest` event, which would be a better fit — it fires when a prompt
would actually be shown, rather than on every tool call — but its payload contract is not
documented, so adopting it would be guesswork.

The `Stop`-blocking contract is documented for *command* hooks in terms of exit code 2,
while this plugin uses HTTP hooks, where the stated equivalent is a non-2xx response. The
server returns `200` with `decision: "block"` in the body, which is what "response body
parsed as JSON per the JSON output rules" should mean. The tests verify the server emits
the right body; whether Claude Code honors it on a 2xx is the part only a live session can
confirm. If queued prompts are silently dropped, that is the first thing to change.

Port 7517 is hardcoded in `hooks.json`. Set `HCP_HOOK_PORT` to move the server, but you
must edit `hooks.json` to match; static config cannot read a runtime value.
