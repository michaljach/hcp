# `hcp` — Claude Code plugin

Exposes the Claude Code session you are *already sitting in* over HCP v0.1, so a phone,
a browser, or another harness can watch it and answer its permission prompts.

```
claude session ──hooks──▶ HCP daemon ──unix socket──▶ client (phone)
                             │                              │
   PreToolUse blocks ────────┘                              │
   permissionDecision ◀──────────── first answer wins ──────┘
```

`claude plugin validate` passes; `npm test` runs 18 end-to-end checks through the real
hook entry point and the real sockets.

## Why this and not the adapter

This repo has two Claude Code implementations, and the difference is architectural.

| | [`claude-code-adapter`](../claude-code-adapter) | this plugin |
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
claude plugin install ./examples/claude-code-plugin      # from a checkout
```

Needs Node 22.6+ on `PATH` — the hooks run `.ts` files directly via native type stripping.

## How it works

`hooks/hooks.json` points six events at one dispatcher, `hooks/hook.ts`:

| Event | What it does |
|---|---|
| `SessionStart` | Starts the daemon if it isn't running, registers this session |
| `UserPromptSubmit` | Emits a `user_message` event, state → `working` |
| `PreToolUse` | **The permission channel.** Classifies, escalates, blocks on the answer |
| `PostToolUse` | Emits `tool_result` |
| `Stop` | State → `idle` |
| `SessionEnd` | State → `ended`, deregisters |

The daemon holds the session state, the `seq`-numbered event log, and the client fan-out.
It listens on two unix sockets in a `0700` directory, kept separate because they carry
different trust: `hook.sock` for this plugin's hooks, `hcp.sock` for HCP clients.

### Staying out of the way

`PreToolUse` returns **no decision** — letting Claude Code's normal permission flow run
exactly as if the plugin were not installed — in three cases:

1. **No client is attached.** Nobody is watching remotely, so nothing should change.
2. **The risk is below the escalation floor.** Default `medium`, configurable as
   `escalate_from`. You do not want your phone buzzing about `git status`.
3. **The request expired** with no answer after 110s. A client that fell asleep must not
   silently block the agent — it hands back to the local prompt.

Every failure path in `hook.ts` also exits 0 with no decision: daemon down, socket gone,
malformed JSON, Node too old. A remote-control plugin that can wedge a local session is
worse than no plugin.

### Timeout chain

Deliberately ordered so the daemon decides rather than the clock: daemon answers at
**110s**, the hook gives up at **118s**, `hooks.json` kills it at **120s**.

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

`/hcp` inside a session prints daemon status and any sessions sitting in `awaiting_input`.

## What it cannot do

**Originate turns.** `session/prompt` and `session/steer` return `-32005`. A hook can
observe and it can decide, but it cannot inject a new turn into a running CLI. This is the
one real cost of living inside the session instead of driving it, and it is why the adapter
still exists.

Also not implemented, all of it specified in the spec and none of it here: `ws://` and
`relay://` transports (unix socket only), pairing and the Noise channel, leases, push,
`fs/*` and `terminal/*`.

## Note

`src/classify.ts` and `src/types.ts` are byte-identical copies of the adapter's. Plugins
must be installable standalone, so they cannot reach outside the plugin root — the test
asserts the copies have not drifted rather than letting them quietly diverge.

`PreToolUse` is the documented, stable hook, so that is what this uses. Claude Code also
fires a `PermissionRequest` event, which would be a better fit — it fires when a prompt
would actually be shown, rather than on every tool call — but its payload contract is not
documented, so adopting it would be guesswork.
