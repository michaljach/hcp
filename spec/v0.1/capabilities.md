# HCP v0.1 — Capabilities

Harnesses differ genuinely. Codex can fork a thread and roll it back; Claude Code models
those operations differently. A protocol that pretends otherwise produces clients full of
buttons that fail at runtime.

## 1. Negotiation

`initialize` is a two-way capability exchange.

**Client → Host:**

```json
{"method":"initialize","params":{
  "protocol_versions":["0.1"],
  "client":{"name":"hcp-mobile","version":"0.3.1","form_factor":"phone"},
  "device_id":"dev_phone",
  "capabilities":{
    "permission_kinds":["exec","write","tool","network","elicit"],
    "render":{"diff":true,"markdown":true,"terminal":false,"images":false},
    "push":true
  }
}}
```

**Host → Client:**

```json
{"result":{
  "protocol_version":"0.1",
  "host":{"name":"hcp-host","version":"0.1.0","platform":"darwin-arm64"},
  "harness":{"name":"claude-code","version":"2.1.258","adapter":"hcp-claude-code/0.1.0"},
  "capabilities":{
    "steer":false,"interrupt":true,"fork":false,"rollback":false,
    "replay":true,"lease":true,"snapshot":true,
    "permission_kinds":["exec","write","tool"],
    "permission_scopes":["once","session"],
    "fs":{"read":true,"write":true,"watch":false},
    "terminal":false,
    "diff":true,
    "push":true,
    "spawn":["same-dir","worktree"]
  }
}}
```

The client's `form_factor` (`phone` | `tablet` | `desktop` | `headless`) is advisory, and
Hosts SHOULD use it to pick `max_delta_hz` defaults and summary verbosity — not to withhold
functionality. A phone that wants the full diff is entitled to it.

## 2. Rules

**Absent means unsupported.** There is no tri-state. A capability the Host did not name is
not available, and a client MUST NOT probe by calling it.

**Advertised means callable.** A Host that advertises `steer` MUST accept `session/steer`
in `working` state. Advertising a capability the adapter cannot deliver is a conformance
failure, not a soft edge.

**Calling an unadvertised method** returns `-32005 capability_unsupported`. Clients SHOULD
treat this as a bug in their own capability handling, not as a normal control-flow path.

**Degrade, don't refuse.** A client MUST remain functional against a Host that advertises
only the mandatory set. Concretely: no `steer` means queue a prompt instead; no `diff` means
skip the diff pane; no `terminal` means hide the tab. Nothing in that list justifies
refusing to attach.

**Client capabilities constrain the Host.** A Host MUST NOT send a `permission_kind` the
client did not advertise. If the only attached client cannot render `elicit`, the Host must
either wait for a capable client or resolve the request some other way — it MUST NOT send a
request the client provably cannot answer, because the result is a silently blocked agent.

## 3. Mandatory set

Everything a conforming Host MUST implement, and therefore everything a client may assume
without checking:

| Method | Why mandatory |
|---|---|
| `initialize` / `initialized` | No negotiation without it |
| `host/sessions/list` | A client must be able to find sessions |
| `session/attach` / `session/detach` | The core operation |
| `session/snapshot` | The recovery path when replay is unavailable |
| `session/prompt` | Input |
| `session/interrupt` | Stopping a runaway agent is not optional |
| `session/update` / `session/state` | Output |
| `session/request_permission` | The reason the protocol exists |
| `session/permission_resolved` / `session/cancel_permission` | Multi-client correctness |

Everything else — `steer`, `lease`, `replay`, `fork`, `rollback`, `fs/*`, `terminal/*`,
`push/*` — is optional and gated.

`replay` is optional but strongly RECOMMENDED. Without it, every reconnect is a full
snapshot, which is survivable on a laptop and painful on a phone with a flaky connection.

## 4. Versioning

`protocol_version` is `MAJOR.MINOR`. Minor versions are additive: new methods, new event
kinds, new optional fields. Major versions may break.

- A peer MUST accept unknown fields in any object.
- A peer MUST ignore unknown `session/update` kinds while still advancing the cursor.
- A peer MUST NOT fail a connection over an unknown minor version; it negotiates down to the
  highest shared version.

The client sends a list, the Host picks one and names it in the result. Where there is no
overlap the Host fails with `-32008 version_unsupported`.
