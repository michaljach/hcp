# HCP v0.1 — Transport

## 1. Framing

Every HCP message is a [JSON-RPC 2.0](https://www.jsonrpc.org/specification) Request,
Response, or Notification. Both peers may originate requests; there is no client-only or
server-only direction.

Batch requests are NOT supported. Implementations MUST reject a JSON array at the top level
with `-32600`.

Request `id` MUST be a string. Numeric ids are rejected — they invite collisions when frames
are relayed and re-tagged.

Every message carries a `hcp` member naming the protocol version in force:

```json
{"jsonrpc":"2.0","hcp":"0.1","id":"c1","method":"session/attach","params":{}}
```

A peer receiving an unknown `hcp` major version MUST fail the connection at `initialize`
rather than guess.

## 2. Transports

A conforming Host MUST support at least one of `stdio` or `unix`, and SHOULD support `ws`.
Support for `relay` is OPTIONAL but required for the mobile case.

### 2.1 `stdio`

Line-delimited JSON on stdin/stdout. One message per line; no embedded newlines. stderr is
reserved for logs and MUST NOT carry protocol traffic.

This is the adapter transport. It is how a Host talks to a Harness process, and it is what
makes an HCP Host implementable against Claude Code today.

### 2.2 `unix`

Same framing as `stdio`, over a Unix domain socket. The socket path MUST be in a directory
owned by the invoking user with mode `0700`. Peer credentials SHOULD be checked with
`SO_PEERCRED` or the platform equivalent; a Host MUST reject peers whose uid differs from
its own unless explicitly configured otherwise.

Local IPC needs no further authentication: filesystem permissions are the authentication.

### 2.3 `ws`

One JSON message per WebSocket **text** frame. Binary frames are reserved and MUST be
rejected in v0.1. Ping/pong is the liveness mechanism; a peer that misses two consecutive
pings SHOULD consider the connection dead and begin reconnect.

**A Host MUST NOT bind a `ws` listener to a non-loopback address without authentication
configured.** Codex's documentation carries the same warning in prose — *"don't expose
app-server transports directly on a shared or public network"* — and HCP makes it a MUST
because the failure mode is an unauthenticated shell on the operator's workstation.

For non-loopback listeners the client MUST authenticate during the WebSocket handshake by
presenting a device credential (see `pairing-and-relay.md`). `wss` is REQUIRED for any
non-loopback listener.

### 2.4 `relay`

An outbound-dialed rendezvous for the case that motivated the protocol: the client is a
phone on a cellular network and the host is a laptop behind NAT, and neither can accept an
inbound connection.

The Host dials `wss` **outbound** to a rendezvous server and holds the connection open. The
Client dials the same rendezvous. The rendezvous copies opaque frames between them and can
decrypt none of it. Full description in [`pairing-and-relay.md`](pairing-and-relay.md).

Relay is a transport, not a trust boundary shift: everything above the framing layer behaves
identically whether the bytes crossed a loopback socket or three networks.

## 3. URIs

Transports are named by URI so a client can be handed one string:

```
stdio://
unix:///Users/me/.hcp/host.sock
ws://127.0.0.1:7517
wss://desk.example:7517
relay://rendezvous.example/r/K7QW-3M2P
```

The `hcp://` scheme is reserved for pairing offers only (see `pairing-and-relay.md`) and
never for transport.

## 4. Connection lifecycle

```
Client                                  Host
  │── initialize ────────────────────────▶│   version, client identity, capabilities
  │◀──────────────── initialize result ───│   host identity, harness info, capabilities
  │── initialized (notification) ────────▶│
  │                                       │
  │── host/sessions/list ────────────────▶│
  │── session/attach {from_seq} ─────────▶│
  │◀────────────── session/update × N ────│   replayed, then live
  │                                       │
  │◀───────── session/request_permission ─│   host asks, client answers
  │── result {option_id} ────────────────▶│
```

`initialize` MUST be the first message. A Host MUST reject any other method before
`initialize` with `-32002` (`not_initialized`).

## 5. Reconnection

Reconnection is a transport concern with a session-layer consequence, and the split matters:

- **Transport** reconnect is the client's business. Exponential backoff starting at 1s,
  capped at 30s, with jitter. A client MUST NOT reconnect in a tight loop.
- **Session** reconnect is `session/attach` with `from_seq` set to the last `seq` the client
  durably processed. See [`sessions.md`](sessions.md).

A dropped transport MUST NOT end a session. Hosts MUST keep sessions running with zero
clients attached — the agent working while nobody watches is the normal case, not an edge
case.

## 6. Errors

Standard JSON-RPC codes, plus:

| Code | Name | Meaning |
|---|---|---|
| `-32001` | `unauthorized` | Credential missing, expired, or revoked |
| `-32002` | `not_initialized` | Method sent before `initialize` |
| `-32003` | `session_not_found` | Unknown or closed `session_id` |
| `-32004` | `replay_unavailable` | `from_seq` older than the retained window |
| `-32005` | `capability_unsupported` | Method valid but not advertised by this host |
| `-32006` | `leased` | Another client holds exclusive control |
| `-32007` | `permission_expired` | Answered after the request timed out |
| `-32008` | `version_unsupported` | No overlapping protocol version |

Error `data` SHOULD carry a `retry_after_ms` where retrying could succeed.
