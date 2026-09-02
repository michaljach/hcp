# HCP v0.1 — Permissions

This is the interop core. Everything else in HCP is plumbing that exists so this message can
reach a phone and get an answer back.

## 1. Why a new envelope

Both target harnesses already have rich approval systems, and they are mutually
unintelligible. Codex dedicates seven distinct server-to-client request types to it —
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`, plus the v1 `applyPatchApproval` and `execCommandApproval`.
Claude Code expresses the same thing as a single `control_request` with a `behavior` field
over stdio.

Neither payload was designed to be rendered on a 6-inch screen at arm's length. Both assume
the reader can see a full diff and a full command line.

HCP normalizes them into one request with a hard requirement: **the envelope must carry its
own summary.** A client MUST be able to render a correct, actionable prompt from `summary`,
`risk`, and `options` alone, without parsing `detail`. Clients with room render `detail` too.

## 2. The request

```json
{"jsonrpc":"2.0","hcp":"0.1","id":"perm_c1a",
 "method":"session/request_permission",
 "params":{
   "session_id":"s_9fk2",
   "seq":1902,
   "action":{
     "kind":"exec",
     "summary":"Run database migrations against the dev database",
     "risk":"high",
     "reversible":false,
     "detail":{
       "command":["npm","run","migrate:dev"],
       "cwd":"/Users/me/dev/api",
       "sandbox":"workspace-write"
     }
   },
   "options":[
     {"id":"allow_once","label":"Allow","kind":"allow","scope":"once"},
     {"id":"allow_session","label":"Allow for this session","kind":"allow","scope":"session"},
     {"id":"reject_once","label":"Deny","kind":"reject","scope":"once"},
     {"id":"reject_feedback","label":"Deny and tell Claude why","kind":"reject","scope":"once","accepts_text":true}
   ],
   "expires_at":"2026-09-02T20:14:31Z"
 }}
```

### `summary` — REQUIRED

One line, imperative, ≤ 120 characters, no markup. It states what will happen, not what the
agent intends. "Run database migrations against the dev database" — not "Claude would like
to proceed with the next step."

Hosts MUST generate this even when the underlying harness does not provide one. Deriving it
from the command or diff is the adapter's job, and it is the single highest-value thing an
adapter does.

### `risk` — REQUIRED

`low` | `medium` | `high`. The Host's assessment, not the model's. It exists so a client can
decide what to put on a lock screen, what to require biometric confirmation for, and what to
auto-collapse.

Guidance: `low` is confined to the workspace and trivially undone. `medium` writes outside
the workspace, installs software, or touches version control history. `high` is anything
networked, destructive, credentialed, or irreversible.

`reversible` is a separate boolean because risk and reversibility are not the same axis: a
`git push --force` is reversible-with-effort and high risk; deleting a scratch file is
irreversible and low risk.

### `kind` and `detail`

| `kind` | `detail` fields |
|---|---|
| `exec` | `command` (argv array), `cwd`, `sandbox`, optional `explanation` |
| `write` | `path`, `diff` (unified), `bytes_added`, `bytes_removed`, `created`, `deleted` |
| `tool` | `server`, `tool`, `arguments`, `mcp` (bool) |
| `network` | `url`, `method`, `direction` |
| `elicit` | `schema` (JSON Schema for the value requested), `prompt` |

`argv` is an array, never a string. A protocol that ships shell strings across a network and
asks a human to approve them has built a quoting bug with a confirmation dialog on it.

`detail` is extensible; unknown fields MUST be ignored. Unknown `kind` values MUST be
rendered from `summary` and `risk` and offered normally — a client that cannot classify a
request can still let a human answer it, and refusing to display it would strand the session.

### `options`

The Host enumerates what it will accept. Clients MUST NOT synthesize options, and MUST NOT
assume `allow_once` exists.

- `kind`: `allow` | `reject`
- `scope`: `once` | `session` | `always`
- `accepts_text`: if true, the response MAY carry a `text` member — the "deny and explain"
  path, which is how a human redirects an agent rather than merely blocking it.

`scope: "always"` is persistent across sessions and Hosts SHOULD require a stronger
confirmation for it. A client on a phone SHOULD NOT offer `always` for `risk: "high"`.

### `expires_at`

Hosts MUST set a timeout. A permission that blocks forever is a hung agent, and an agent
that hangs silently while its owner is asleep is the failure this protocol exists to
prevent. On expiry the Host MUST behave as if the most restrictive `reject` option was
chosen, and MUST emit `session/permission_resolved` with `resolved_by: null` and
`option_id: null`.

## 3. The response

```json
{"jsonrpc":"2.0","hcp":"0.1","id":"perm_c1a",
 "result":{"option_id":"reject_feedback","text":"Use the staging database, not dev"}}
```

Nothing else. The client does not restate the action, and the Host MUST NOT trust a client
that echoes one back — the `request_id` is the binding, and matching on anything else
invites a confused-deputy bug where a client answers a different question than the one that
was asked.

## 4. Broadcast and resolution

A permission request goes to **every** attached client (see
[`sessions.md`](sessions.md#4-multi-client-concurrency)). First well-formed response wins.
The Host then broadcasts `session/permission_resolved` naming the answering device, and all
other clients dismiss.

If the agent abandons the request — the turn was interrupted, the harness backed out — the
Host MUST send `session/cancel_permission` so clients tear down prompts instead of leaving a
dead dialog on a phone.

Permission responses are never gated by a lease. Anyone attached can unblock a stuck agent.

## 5. Worked trace

A migration approved from a phone while the laptop's lid is shut.

```
seq 1901  H→C*  session/state          {state: "working"}
seq 1902  H→C*  session/request_permission
                  summary: "Run database migrations against the dev database"
                  risk: "high", reversible: false
                  detail.command: ["npm","run","migrate:dev"]
                  expires_at: +120s
          H→push  wake devices with a pending permission
          C(phone) attaches, sees pending_permissions: ["perm_c1a"]
          C(phone)→H  result {option_id: "reject_feedback",
                              text: "Use the staging database, not dev"}
seq 1903  H→C*  session/permission_resolved
                  option_id: "reject_feedback"
                  resolved_by: {device_id: "dev_phone", client_id: "cl_3"}
seq 1904  H→C*  session/update {kind: "user_message",
                  text: "Use the staging database, not dev",
                  origin: {device_id: "dev_phone"}}
seq 1905  H→C*  session/update {kind: "agent_message_delta", ...}
```

Three properties fall out of the design and are worth stating:

1. The laptop's terminal, if anyone reopens it, replays from its cursor and sees the phone's
   answer attributed to the phone.
2. `resolved_by` makes "who approved this" answerable after the fact.
3. The rejection text became a user message, so the agent got redirected rather than merely
   stopped — a denial that carries a reason is worth far more than a denial that does not.
