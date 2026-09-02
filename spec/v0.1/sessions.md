# HCP v0.1 — Sessions

A **session** is a long-lived agent conversation bound to a workspace, owned by a Host,
observable by any number of Clients. It is the unit ACP does not have and UHP does not model.

## 1. Lifecycle

```
        ┌──────────┐
        │ starting │
        └────┬─────┘
             ▼
    ┌───▶ ┌──────┐ ◀──────────────┐
    │     │ idle │                │
    │     └──┬───┘                │
    │        │ prompt             │ turn ends
    │        ▼                    │
    │   ┌─────────┐               │
    │   │ working ├───────────────┘
    │   └────┬────┘
    │        │ harness blocks on a question
    │        ▼
    │  ┌────────────────┐
    └──┤ awaiting_input │
       └────────────────┘

  any state ──▶ suspended ──▶ idle
  any state ──▶ ended (terminal)
```

`awaiting_input` is a first-class state, not an internal detail. It is the state that earns
a push notification, the state a client badges in a session list, and the state that tells a
user which of nine running sessions actually needs them. Both vendors compute this
internally; HCP requires it on the wire.

`suspended` covers a host that is alive but not running the harness — a laptop that slept, a
sandbox that was paused. Distinguishing it from `idle` prevents a client from reporting a
session as ready when it cannot accept input.

## 2. Event log and `seq`

Every session carries a strictly monotonic, gapless `seq`, starting at 1, incremented once
per emitted event. `seq` is per session, assigned by the Host, and never reused.

This single field does most of the work in the protocol:

- Reconnect is `attach(from_seq)`, not a resynchronization negotiation.
- Two clients can be at different positions in the same session without coordination.
- A client can prove it processed an event durably before advancing its cursor.
- Ordering is total, so "what happened first" has an answer.

### Retention

A Host MUST retain, per session, whichever comes first: **10,000 events or 24 hours**, and
MUST report `oldest_seq` in `session/attach` results and `host/sessions/list` entries.

A client requesting `from_seq` below `oldest_seq` receives `-32004 replay_unavailable` and
MUST recover with `session/snapshot`. The floor is a v0.1 guess; see open questions.

### Snapshot

`session/snapshot` returns the current materialized state — conversation, session state,
pending permission requests, token usage, workspace summary — plus the `seq` it is current
as of. A client that snapshots at `seq = N` then attaches with `from_seq = N` has no gap and
no duplicate.

## 3. Attach

```json
{"method":"session/attach","params":{
  "session_id":"s_9fk2",
  "from_seq": 1841,
  "stream": {"deltas": true, "max_delta_hz": 10}
}}
```

Result:

```json
{"session_id":"s_9fk2","state":"working","seq":1903,"oldest_seq":412,
 "subscription_id":"sub_77","replaying":true,
 "pending_permissions":["perm_c1a"]}
```

The Host then emits every event from `from_seq + 1` forward, marked `replayed: true`, and
transitions seamlessly to live events. There is no separate "caught up" handshake — the
`replayed` flag falling away is the signal, and a client that treats replayed and live
events identically is correct by construction.

`pending_permissions` in the attach result is what makes a phone useful the instant it
wakes: the client knows immediately that the session is blocked and on what, without waiting
for a re-emission.

`max_delta_hz` lets a battery-powered client ask for coalesced updates. The Host MUST honor
it by merging deltas, never by dropping events — `seq` must stay gapless.

## 4. Multi-client concurrency

Neither vendor has published rules for this, and it is where a naive implementation breaks.
HCP's rules:

### Input is serialized, never merged

All input — `session/prompt`, `session/steer` — enters a single per-session queue in Host
arrival order. The Host MUST echo every accepted input to **all** attached clients as an
event carrying the originating `client_id` and `device_id`.

The phone must see what the laptop typed. A control plane where two surfaces silently
diverge is worse than no control plane.

### Permissions are broadcast, first answer wins

A `session/request_permission` MUST go to every attached client. The first well-formed
response resolves it. The Host then broadcasts:

```json
{"method":"session/permission_resolved","params":{
  "request_id":"perm_c1a","option_id":"allow_once",
  "resolved_by":{"client_id":"cl_3","device_id":"dev_phone"},
  "seq": 1904
}}
```

Every other client MUST dismiss its prompt. Late responses get `-32007 permission_expired`,
which is an expected outcome and MUST NOT be surfaced as an error to the user.

Attributing the answer is deliberate: in a shared session, "who approved the deploy" is an
audit question, and the protocol should be able to answer it.

### Optional exclusive control

```json
{"method":"session/lease","params":{"session_id":"s_9fk2","ttl_ms":300000}}
```

While a lease is held, input from other clients is rejected with `-32006 leased`, carrying
the holder's `device_id` so a UI can say *"your laptop has control"* rather than failing
opaquely. Leases expire on TTL and are released by `session/release` or by the holder
detaching. Permission responses are NEVER leased — anyone attached can unblock a stuck
agent, because the alternative is an agent blocked until a lease expires.

## 5. Steering vs. prompting

Two distinct methods, because the harnesses distinguish them and collapsing them loses
information:

- **`session/prompt`** — a new turn. Valid in `idle`. Queued if the session is `working`.
- **`session/steer`** — mid-turn course correction, delivered to the agent without ending
  the current turn. Valid in `working`. Maps to Codex's `turn/steer`. A Host whose harness
  cannot do this MUST NOT advertise the `steer` capability, and clients MUST fall back to
  queueing a prompt.

`session/interrupt` stops the current turn and returns to `idle`.

## 6. Events

`session/update` carries every observable change:

```json
{"method":"session/update","params":{
  "session_id":"s_9fk2","seq":1902,"replayed":false,
  "update":{"kind":"agent_message_delta","text":"Running the migration now"}
}}
```

Defined `kind` values in v0.1:

| Kind | Carries |
|---|---|
| `user_message` | Input, with originating client and device |
| `agent_message` / `agent_message_delta` | Assistant output |
| `reasoning_delta` | Reasoning summary text, where the harness exposes it |
| `plan` | Structured task list |
| `tool_call` / `tool_result` | Tool invocation and outcome |
| `command_output_delta` | Streaming stdout/stderr from an executed command |
| `file_change` | Path, unified diff, byte counts |
| `diff_summary` | Aggregate working-tree diff |
| `token_usage` | Context and cost accounting |
| `subagent` | Nested agent lifecycle |
| `error` / `warning` | Host or harness diagnostics |

`session/state` is emitted separately on every state transition, so a client can drive a
badge without parsing the update stream.

Unknown `kind` values MUST be ignored and MUST still advance the cursor. This is what lets a
host add event types without breaking old phones.
