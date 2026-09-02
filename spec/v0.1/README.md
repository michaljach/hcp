# HCP v0.1 — Overview

**Status:** draft. Breaking changes expected. Version string: `0.1`.

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in RFC 2119.

## 1. Roles

HCP defines three roles and one optional fourth. A single program may fill more than one.

| Role | Responsibility |
|---|---|
| **Harness** | The coding agent itself — Claude Code, Codex, or another. Does not speak HCP. |
| **Host** | Owns harness processes, holds session state and the event log, and speaks HCP. Outlives any client connection. |
| **Client** | A control surface: a terminal, an editor, a web page, a phone. Attaches to sessions. |
| **Rendezvous** | Optional. Relays frames between a Host and a Client that cannot reach each other directly. Never sees plaintext. |

An **adapter** is the shim that makes a Harness speak Host. In practice adapters are the
only per-vendor code in the system; everything above the Host boundary is uniform.

```
  Client (phone)  ─┐
  Client (web)    ─┼── [Rendezvous] ──┐
  Client (term)   ─┘                  │
                                      ▼
                                    Host ── adapter ── Harness (claude / codex)
  Client (editor) ─── ws:// direct ──┘
```

## 2. Design principles

**No privileged client.** The terminal in front of the machine and the phone on the sofa
are the same kind of peer. This is the single most important idea, and it is borrowed
directly from `codex --remote`: if the local UI has a private back door, every remote
feature is second-class forever.

**The Host is the source of truth.** Clients hold a cache and a cursor. Any client may be
killed at any moment with no effect on the session. Reconnection is a cursor operation, not
a renegotiation.

**Reuse ACP's vocabulary.** Where ACP names a thing, HCP uses ACP's name — `initialize`,
`session/prompt`, `session/update`, `session/request_permission`, `fs/read_text_file`. An
ACP client should port to HCP by changing transport and adding attach, not by relearning
the protocol. Divergence must be justified by something ACP cannot express.

**The envelope carries the rendering.** A protocol whose approval messages can only be
displayed on a large screen has failed at the job that motivated it. Every request that
blocks the agent MUST carry a one-line summary and a risk grade alongside its full payload.

**The relay is optional and untrusted.** Direct `ws://` and local `unix://` are first-class.
Where a relay is used it MUST NOT be able to read session content.

## 3. Method index

Direction is `C→H` (client to host), `H→C`, or `↔`.

### Connection
| Method | Dir | Kind |
|---|---|---|
| `initialize` | C→H | request |
| `initialized` | C→H | notification |
| `shutdown` | ↔ | request |

### Host scope
| Method | Dir | Kind |
|---|---|---|
| `host/sessions/list` | C→H | request |
| `host/sessions/create` | C→H | request |
| `host/sessions/close` | C→H | request |
| `host/devices/list` | C→H | request |
| `host/devices/revoke` | C→H | request |
| `host/status` | H→C | notification |

### Session scope
| Method | Dir | Kind |
|---|---|---|
| `session/attach` | C→H | request |
| `session/detach` | C→H | request |
| `session/snapshot` | C→H | request |
| `session/replay` | C→H | request |
| `session/prompt` | C→H | request |
| `session/steer` | C→H | request |
| `session/interrupt` | C→H | request |
| `session/lease` | C→H | request |
| `session/release` | C→H | request |
| `session/update` | H→C | notification |
| `session/state` | H→C | notification |

### Blocking requests
| Method | Dir | Kind |
|---|---|---|
| `session/request_permission` | H→C | request |
| `session/permission_resolved` | H→C | notification |
| `session/cancel_permission` | H→C | notification |

### Workspace
| Method | Dir | Kind |
|---|---|---|
| `fs/read_text_file` | C→H | request |
| `fs/write_text_file` | C→H | request |
| `fs/diff` | C→H | request |
| `terminal/create` | C→H | request |
| `terminal/output` | C→H | request |
| `terminal/kill` | C→H | request |

### Notification delivery
| Method | Dir | Kind |
|---|---|---|
| `push/register` | C→H | request |
| `push/unregister` | C→H | request |

`fs/*` and `terminal/*` are OPTIONAL and gated on capabilities. They exist so a remote
client can render a diff pane or a log tail without a second channel — the same job Claude
Code's diff pane does today by asking the local process to compute it.

## 4. What v0.1 deliberately leaves out

- **Task submission.** Handing a harness a job and collecting artifacts is
  [UHP](https://unifiedharnessprotocol.org)'s problem, and HTTP+SSE solves it better than a
  relay protocol would. HCP starts once a session exists.
- **Agent-to-agent delegation.** That is A2A's axis.
- **Model or provider configuration.** Host-local concern; adapters expose it or don't.
- **Billing, quota, telemetry.** Vendor concerns that do not belong in an interop spec.

## 5. Open questions

Tracked honestly rather than papered over.

1. **Crypto review.** The handshake in `pairing-and-relay.md` is specified against a
   standard Noise pattern but has not been reviewed by anyone qualified. Treat it as a
   sketch of intent.
2. **Lease semantics.** Whether exclusive control should be advisory (current draft) or
   enforced with a hard input rejection is unsettled.
3. **Replay window.** The retention floor is a guess pending real deployment numbers.
4. **Streaming granularity.** Whether `session/update` should carry token-level deltas to a
   phone, or coalesce, is a battery question that needs measurement.
