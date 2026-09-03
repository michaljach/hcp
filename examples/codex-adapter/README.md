# `hcp-codex` — reference adapter

An HCP v0.1 Host that drives the **Codex app-server**. The second conformance target from
[`spec/v0.1/README.md`](../../spec/v0.1/README.md), and the easier of the two: Codex is
already JSON-RPC 2.0 with pluggable transports and a generated schema, so the adapter is
mostly renaming.

**Zero dependencies, no build step.**

```bash
npm test        # 22 checks, no codex binary or tokens needed
npm run mock    # HCP Host on stdio, scripted harness
npm start       # HCP Host on stdio, spawns `codex app-server`
```

## Why this adapter is the interesting one

It exists to make a claim in the spec checkable rather than merely asserted. Of the six
source files, **five are byte-identical to the Claude Code adapter's**:

| File | Codex-specific? |
|---|---|
| `src/host.ts` | No — identical |
| `src/shared.ts` | No — identical |
| `src/classify.ts` | No — identical |
| `src/types.ts` | No — identical |
| `src/main.ts` | Only the harness constructor |
| `src/harness.ts` | **Yes — the whole adapter** |

The smoke test asserts that identity on every run. If someone leaks Codex knowledge into
`host.ts`, the test fails.

## How `classify.ts` stays shared

Codex delivers approvals already structured — `command`, `cwd`, `reason` — where Claude
Code sends an opaque tool blob. Rather than fork the classifier, the driver normalizes
Codex's typed params into the same `{toolName, input}` shape the classifier already grades:

```
item/commandExecution/requestApproval  ->  { toolName: "Bash",  input: { command, cwd, description: reason } }
item/fileChange/requestApproval        ->  { toolName: "Edit",  input: { file_path: grantRoot, ... } }
item/permissions/requestApproval       ->  { toolName: "PermissionProfile", ... }
```

Risk grading is universal — a force-push is dangerous regardless of which harness proposed
it. Only payload mapping is per-harness.

## Where Codex is richer than Claude Code

This is what capability negotiation is for, and both adapters exercise it honestly.

| | Claude Code adapter | Codex adapter |
|---|---|---|
| `steer` | `false` — `session/steer` returns `-32005` | `true` — maps to `turn/steer` |
| `fork` / `rollback` | `false` | `true` |
| `terminal` | `false` | `true` — `command/exec` |
| `elicit` permissions | not advertised | advertised |
| Deny with a reason | `reject_feedback` — the message rides in `control_response` | **not offered** |
| Deny and stop the turn | not offered | `reject_cancel` -> `cancel` |

The last two rows are the ones worth noticing. Codex's `decline` decision carries no
message field, so this adapter must not advertise `reject_feedback` — a client would offer
a text box whose contents went nowhere. Conversely Codex can deny *and interrupt the turn*,
which Claude Code cannot, so `reject_cancel` exists here and nowhere else.

Option sets come from the harness for exactly this reason. `spec/v0.1/capabilities.md`:
advertised means callable.

### Decision mapping

| HCP option | Codex decision |
|---|---|
| `allow_once` | `accept` |
| `allow_session` | `acceptForSession` |
| `reject_once` | `decline` |
| `reject_cancel` | `cancel` |

On expiry the Host picks the most restrictive reject, which for Codex means `cancel`.

## The real transport

`npm start` spawns `codex app-server --listen stdio://`. Codex also serves the same
protocol over a socket, which is what a networked deployment would use:

```bash
codex app-server --listen ws://127.0.0.1:7699 \
                 --ws-auth capability-token --ws-token-file /run/hcp/token
```

Connecting to that instead of spawning is a change to `CodexHarness.start()` and nothing
else — but it is not implemented here, and neither are HCP's own `ws://` and `relay://`
transports, pairing, leases, or push.

## Caveat

The app-server shapes in `harness.ts` are codex-cli 0.150.x, read from
`codex app-server generate-json-schema --out DIR`. They are confined to that one file so
drift has a single home. Regenerate the schema to check them against your Codex build.
