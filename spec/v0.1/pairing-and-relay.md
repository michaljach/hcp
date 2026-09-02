# HCP v0.1 — Pairing and Relay

The two pieces no existing standard provides: how a phone earns the right to control a
laptop, and how it reaches one it cannot route to.

## Part 1 — Pairing

### 1.1 Device identity is a keypair

A device is identified by an **Ed25519 public key**, not a bearer token.

Both vendors use bearer credentials today. Bearer tokens are simpler and strictly weaker: a
token captured in transit, lifted from a log, or read out of a relay's memory is a working
credential. A device that must sign a fresh challenge cannot be impersonated by anyone who
merely observed it.

The cost of the upgrade is one signature per connection. It is worth it, because the thing
being protected is arbitrary command execution on a developer's workstation.

### 1.2 Enrollment

```
Host                                            Client (phone)
  │
  │ operator runs: hcp-host pair
  │ generates offer:
  │   code   = "K7QW-3M2P"        (8 chars, Crockford base32, single use)
  │   expiry = now + 120s
  │   host_pk, host_fingerprint
  │
  │ renders QR: hcp://pair?c=K7QW-3M2P&h=<fp>&r=<rendezvous>
  │                                                │
  │◀──── pair/begin {code, device_pk, name} ───────│
  │                                                │
  │ verify code, unexpired, unused                 │
  │ display fingerprint of device_pk on the host   │
  │ operator confirms it matches the phone         │
  │                                                │
  │───── pair/complete {host_pk, device_id} ──────▶│
  │                                                │
  │ persist device to roster                       │
```

The offer is **single-use and short-lived** — default 120 seconds. Codes are drawn from
Crockford base32, which excludes `I`, `L`, `O` and `U`, because these get read aloud and
typed by hand.

Both sides display a fingerprint of the other's key, and the operator confirms they match.
This is what closes the machine-in-the-middle window during enrollment, and it is the one
step that cannot be automated away.

### 1.3 The roster

The Host keeps a durable device roster: `device_id`, public key, display name, enrollment
time, last-seen time, and scope.

```json
{"method":"host/devices/list"}
→ {"devices":[
    {"device_id":"dev_phone","name":"Michal's iPhone","pk":"ed25519:...",
     "enrolled_at":"2026-09-01T10:22:00Z","last_seen":"2026-09-02T19:58:11Z",
     "scope":{"sessions":"all","permission_scopes":["once","session"]}}]}
```

`host/devices/revoke` removes a device immediately and MUST terminate its live connections.
Revocation that only takes effect on next connect is not revocation.

Per-device scope lets a phone be enrolled with narrower authority than a laptop — for
example barred from granting `scope: "always"` permissions. This is a policy hook, not
enforcement against a compromised Host.

### 1.4 Connection authentication

Every connection, on every transport except `stdio` and same-uid `unix`:

1. Host sends a 32-byte random challenge.
2. Client returns `sign(device_sk, challenge ‖ host_pk ‖ transport_binding)`.
3. Host verifies against the roster.

The `transport_binding` is the TLS exporter value where TLS is in use, so a signature
captured on one connection cannot be replayed onto another.

## Part 2 — Relay

### 2.1 The problem

The motivating case is a phone on a cellular network and a laptop behind NAT. Neither can
accept an inbound connection. Both vendors solved this with a relay they own — sensibly, and
in a way nobody else can use.

### 2.2 Why a neutral relay must be end-to-end encrypted

Anthropic's and OpenAI's relays carry plaintext, and that is a defensible choice for them:
you are already sending the model your source code, so the relay operator learns nothing new.

A neutral relay has no such standing. Nobody will route a private repository through a
stranger's server in plaintext, and a protocol that asks them to will simply not be adopted
outside the two vendors that already have relays. So:

**A Rendezvous MUST NOT be able to read session content.** It sees ciphertext, frame sizes,
and routing metadata. Nothing else.

This is the design constraint that makes a vendor-neutral relay possible at all, and it is
HCP's main contribution over what exists.

### 2.3 Rendezvous flow

```
Host                       Rendezvous                    Client
  │                             │                           │
  │── wss outbound, sign ──────▶│                           │
  │◀── rendezvous_id "K7QW" ────│                           │
  │        (holds open)         │                           │
  │                             │◀── connect(K7QW), sign ───│
  │                             │                           │
  │◀════════ Noise_XK handshake, relayed opaquely ═════════▶│
  │                             │                           │
  │◀════════ encrypted HCP frames ════════════════════════▶│
```

1. The Host dials the Rendezvous **outbound** over `wss` and authenticates with its host
   key. No inbound port is opened on the developer's machine, which is the same property
   Claude Code's outbound-polling design achieves.
2. The Rendezvous issues a `rendezvous_id` and holds the connection open.
3. The Client connects, authenticates with its device key, and names the `rendezvous_id`.
4. Host and Client run a **Noise_XK** handshake (X25519 / ChaCha20-Poly1305 / BLAKE2s) using
   the keys exchanged at pairing. `XK` because the Client already knows the Host's static key
   from the pairing offer, and the Host learns the Client's during the handshake.
5. Everything after is an opaque encrypted frame the Rendezvous copies without inspecting.

### 2.4 What the Rendezvous learns anyway

Stated plainly, because a privacy claim with an unstated residue is a lie:

- That a given host key and device key are communicating, and when
- Frame sizes, timing, and volume
- Source IP addresses of both parties
- Connection and disconnection events

It does not learn session content, workspace paths, prompts, code, commands, or approvals.

Padding and cover traffic are out of scope for v0.1. Operators who consider traffic analysis
part of their threat model should run their own Rendezvous — which is the point of
specifying it rather than hosting it.

### 2.5 Rendezvous obligations

A conforming Rendezvous:

- MUST NOT log frame contents.
- MUST NOT accept a client connection for a `rendezvous_id` whose host is not connected.
- MUST rate-limit connection attempts per device key.
- MUST drop both sides when either disconnects, so a stale half-open channel cannot be
  adopted by a later connection.
- SHOULD expire idle channels and publish its retention policy for connection metadata.
- MUST NOT be required. Direct `wss` and local `unix` are first-class transports, and an
  implementation that only works through a relay is not conforming.

### 2.6 Push notifications

A phone that is asleep is not attached, and an agent blocked on a permission at 2am needs to
reach it.

```json
{"method":"push/register","params":{
  "device_id":"dev_phone",
  "transport":"apns",
  "token":"...",
  "triggers":["awaiting_input","turn_complete","error"]
}}
```

The push payload MUST carry only `session_id`, `trigger`, and the permission `summary` —
never `detail`. A lock screen is a public surface, and the summary field was designed for
exactly this constraint.

Push delivery necessarily involves a vendor push service (APNs, FCM), which is the one place
where content leaves the end-to-end envelope. The mitigation is that the summary is the only
thing that goes, and clients SHOULD offer a setting to suppress it entirely and send a
contentless wake.

## 3. Security notes

**HCP grants command execution.** A device on the roster can make an agent run arbitrary
commands on the Host's machine. Enrollment must be treated with the seriousness of adding an
SSH key, and the fingerprint confirmation step exists to enforce that.

**The Host is the security boundary.** Permission scopes, sandboxing, and approval policy
are enforced Host-side. A client is untrusted input. A Host MUST NOT accept a client
assertion about what was previously approved.

**Not reviewed.** The handshake here is specified against a standard, well-analyzed Noise
pattern rather than invented, but this document has not been reviewed by a cryptographer.
Before anyone ships this, it needs to be.
