# `hcp-claude-code` — reference adapter

An HCP v0.1 Host that drives the **Claude Code CLI**. It is the conformance target named in
[`spec/v0.1/README.md`](../../spec/v0.1/README.md), and it needs no cooperation from
Anthropic: it speaks the CLI's documented stdio control protocol.

**Zero dependencies, no build step.** Node 22.6+ strips TypeScript types natively, so the
`.ts` files run directly.

```bash
npm test              # classifier grading + end-to-end smoke test, no tokens needed
npm run mock          # HCP Host on stdio, scripted harness
npm start             # HCP Host on stdio, real Claude Code CLI
```

## What it does

```
HCP client  ──stdio JSON-RPC──▶  Host  ──stream-json──▶  claude
(phone, web, terminal)            │
                                  ├── event log + seq + replay
                                  ├── permission classifier
                                  └── multi-client fan-out
```

The CLI is driven with the four flags that make it programmable:

```bash
claude --output-format stream-json --input-format stream-json --verbose \
       --permission-prompt-tool stdio
```

Without `--permission-prompt-tool stdio` there is no approval channel and tools auto-deny in
non-interactive mode.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | HCP wire types, mirroring `schema/hcp-v0.1.schema.json` |
| `src/classify.ts` | **The permission classifier** — the piece that earns the adapter's keep |
| `src/harness.ts` | Claude Code stream-json driver, plus a scripted mock |
| `src/host.ts` | Sessions, `seq` log, attach/replay, fan-out, permission broadcast |
| `src/main.ts` | stdio transport and entry point |
| `test/classify.ts` | Grading table across 20 tool invocations |
| `test/smoke.ts` | 24-check end-to-end run over the real stdio transport |

Only `classify.ts` and `harness.ts` are Claude-Code-specific. `host.ts` is harness
independent — pointing this at Codex means replacing those two files and nothing else.

## The classifier

Claude Code hands over a raw tool invocation:

```json
{"tool_name": "Bash", "input": {"command": "npm run migrate:dev"}}
```

which assumes a terminal is rendering it. HCP requires that a client be able to draw a
correct prompt from `summary` + `risk` + `options` alone, because that is what fits on a lock
screen. So the adapter produces:

```json
{"kind": "exec",
 "summary": "Run database migrations: npm run migrate:dev",
 "risk": "high", "reversible": false,
 "detail": {"command": ["npm","run","migrate:dev"], "cwd": "…", "sandbox": "workspace-write"}}
```

Grading is deliberately conservative — an unrecognized command grades `medium`, never `low`,
because an unfamiliar command is not evidence of safety. `npm test` prints the full table.

## Try it by hand

```bash
node src/main.ts --harness mock
```

then paste, one line at a time:

```json
{"jsonrpc":"2.0","hcp":"0.1","id":"1","method":"initialize","params":{"protocol_versions":["0.1"],"client":{"name":"manual","version":"0.1.0","form_factor":"desktop"},"device_id":"dev_laptop"}}
{"jsonrpc":"2.0","hcp":"0.1","id":"2","method":"host/sessions/list"}
{"jsonrpc":"2.0","hcp":"0.1","id":"3","method":"session/attach","params":{"session_id":"PASTE_ID","from_seq":0}}
{"jsonrpc":"2.0","hcp":"0.1","id":"4","method":"session/prompt","params":{"session_id":"PASTE_ID","text":"apply the migrations"}}
```

A `session/request_permission` arrives. Answer it the way a phone would:

```json
{"jsonrpc":"2.0","hcp":"0.1","id":"PASTE_PERM_ID","result":{"option_id":"reject_feedback","text":"Use staging, not dev"}}
```

## Not implemented

Honest scope for an example. All of it is specified; none of it is here.

- **`ws://` and `relay://` transports.** stdio only. The Host is transport-agnostic, so
  adding them is a new file, not a refactor.
- **Pairing, device roster, Noise channel.** No auth at all — stdio's authentication is the
  process boundary, which is exactly what the spec says, but it also means this is not
  something to expose on a network.
- **Leases** and **push**. Advertised as `false` in `initialize`.
- **`fs/*` and `terminal/*`.** Advertised `terminal: false`.
- **`allow_session` scope** is approximated by tool name rather than by matching the specific
  action.

## Caveat

The stream-json envelope shapes in `harness.ts` are Claude Code 2.1.x and are not a published
standard. They are confined to that one file so that when they drift, exactly one thing needs
fixing.
