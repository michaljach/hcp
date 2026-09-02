# HCP Prior Art & Landscape

Research date: 2026-09-02. Versions inspected locally: Claude Code 2.1.258, codex-cli 0.150.1.

## 1. Does something like HCP already exist?

Short answer: the pieces exist, the thing you're describing does not. Five relevant
layers, none of which covers "remote client attaches to a running harness session."

| Standard | Axis it covers | Transport | Gap vs HCP |
|---|---|---|---|
| **MCP** | agent → tools | JSON-RPC (stdio/HTTP) | Wrong axis. Feeds an agent; doesn't control one. |
| **ACP** (Agent Client Protocol) | editor ↔ agent | JSON-RPC 2.0 over stdio (NDJSON) | Closest semantics. **Assumes a local subprocess.** Remote transport is roadmap, not shipped. |
| **A2A** (Agent2Agent) | agent ↔ agent | HTTP/JSON-RPC | Peer delegation, not a human-facing control plane. |
| **AGENTS.md / SKILL.md** | instruction files | n/a | Config format, not transport. |
| **UHP** (Unified Harness Protocol) | app → harness | HTTP + SSE | Closest direct prior art. **Task-shaped, not session-steering.** |

### ACP — Agent Client Protocol (Zed, Aug 2025)

The "LSP for coding agents." JSON-RPC 2.0, line-delimited over stdin/stdout, editor
spawns the agent as a subprocess.

Method vocabulary worth borrowing wholesale:

- Agent methods: `initialize`, `authenticate`, `session/new`, `session/prompt`,
  `session/load`, `logout`, `session/set_mode`
- Client methods: `session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`, `terminal/create`, `terminal/output`, `terminal/kill`,
  `elicitation/create`
- Notifications: `session/update`, `session/cancel`, `elicitation/complete`

Adoption is real: JetBrains joined shortly after launch, the ACP Registry went live
inside both Zed and JetBrains in Jan 2026, and ACP was the headline feature of Zed 1.0
(Apr 2026). Community adapters already bridge both target harnesses —
`claude-agent-acp` (official, via Claude Agent SDK), `acp-claude-code`,
`claude-code-cli-acp` (Rust PTY bridge), and `codex-acp`.

**The gap:** remote transports — letting a client connect to an agent on another
machine — were still unshipped as of mid-2026. ACP has the vocabulary but not the
network model. That is precisely HCP's opening.

### UHP — Unified Harness Protocol (HarnessRouter / Epsilla)

The one project explicitly aiming at "a shared execution contract across agent
harnesses." Spec at unifiedharnessprotocol.org, version `2026-08-11`, Apache-2.0,
implemented by HarnessRouter Community Edition (Docker) and Cloud.

- HTTP + JSON. `GET /v1/harnesses` for discovery, `POST /v1/responses` to submit work.
- Streaming via Server-Sent Events; final event carries the finished `response` object.
- Session continuity via `previous_response_id`. Bearer-token auth.
- Claims Codex, Claude Code, and Hermes as supported harnesses.

**The gap:** it is shaped like OpenAI's Responses API — submit a task, stream results,
collect artifacts. It is not an interactive control plane. No multi-client attach to a
live session, no rich bidirectional approval round-trips, no reconnect/resume
semantics, no push-notification model, no device pairing. "Run a task on a harness" ≠
"steer a running session from my phone."

### Verdict

Nothing today standardizes a **long-lived, interactive harness session that multiple
remote clients can attach to, steer, approve tool calls in, and reconnect to, across
vendors.** Both vendors have built exactly that — separately, incompatibly, and
closed. Third-party mobile clients have to screen-scrape.

Evidence for that last point: **Tactic Remote** (formerly Claude Remote) is a shipping
mobile control layer for Claude Code, Codex, Amp, and Droid. Its architecture: a Node
WebSocket server on your Mac drives the agent **through tmux** — `tmux send-keys` to
type, `tmux capture-pane` to read. Their own docs state there is no API between the
server and Claude Code; it controls the agent the same way a human does. That is the
strongest possible argument that HCP should exist.

Governance context: the Linux Foundation formed the **Agentic AI Foundation** (Dec
2025) with MCP (Anthropic), goose (Block), and AGENTS.md (OpenAI) as founding
projects; platinum members include AWS, Anthropic, Block, Bloomberg, Cloudflare,
Google, Microsoft, and OpenAI. There is a live, neutral venue for a protocol like this.

## 2. How Claude Code does remote

Claude has a *family* of remote surfaces, not one mechanism.

### Remote Control — `claude remote-control`

Connects claude.ai/code and the Claude iOS/Android apps to a session running on your
machine. Execution, filesystem, and MCP servers stay local.

**Architecture.** Outbound-only. The local process makes outbound HTTPS to
`api.anthropic.com:443`, registers, and polls for work; when a device connects, the
server routes messages between client and local session over a streaming connection.
No inbound ports — the Tailscale/ngrok pattern. All traffic over TLS through the
Anthropic API. Credentials are "multiple short-lived credentials, each scoped to a
single purpose and expiring independently."

**Server mode** keeps a process running that serves many sessions:

```
claude remote-control [--name <title>] [--spawn same-dir|worktree|session]
                      [--capacity N]        # default 32
                      [--permission-mode acceptEdits|auto|bypassPermissions|default|dontAsk|plan]
                      [--continue | --session-id <id>]
                      [--sandbox|--no-sandbox] [--verbose] [--debug-file <path>]
```

Prints a session URL; spacebar shows a QR code. Session names default to
`<hostname>-<random-words>`; press `w` to toggle same-dir/worktree at runtime.

**What connected devices get.** Synced conversation, subagent and workflow progress,
and a git diff pane — the device requests the diff over the connection and Claude Code
computes it locally. Messages can be sent from terminal, browser, and phone
interchangeably.

**Auth model.** Requires a claude.ai subscription and a *full-scope* login token. API
keys are not supported; `setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` tokens are rejected
because they can only make model requests. Only works against `api.anthropic.com` —
Bedrock, Vertex, Foundry, or a custom `ANTHROPIC_BASE_URL` (gateway/proxy) cannot pair.
Team/Enterprise requires an Owner to enable it; some compliance configurations disable
it outright.

**Trusted Devices.** Org-wide setting. Each browser, phone, or desktop app enrolls its
own credential, and enrollment is only offered shortly after a full sign-in. Step-up
via platform authenticator (Face ID / Touch ID / Windows Hello) or hardware key.

**Reconnection.** Each conversation carries a "reconnection record" naming the owning
account; resume behavior keys off it. Push notifications are model-decided — Claude
sends one when a long task finishes or it needs a decision.

**Limits.** Outside server mode, one remote session per interactive process.

**Local artifacts observed.** `~/.claude/daemon/` holds `control.key`, `roster.json`,
`dispatch/`, `attach-journal/`; the daemon binds a control socket at
`/tmp/cc-daemon-<uid>/<id>/control.sock` and exits after 5s idle with no clients.
`~/.claude/remote-settings.json` holds remote config.

### The other surfaces

| Surface | Trigger | Runs on |
|---|---|---|
| Dispatch | Message a task from the mobile app | Your machine (Desktop) |
| Remote Control | Drive a running session from web/mobile | Your machine (CLI or VS Code) |
| Channels | Push events from Telegram/Discord/your server | Your machine (CLI) |
| Slack | `@Claude` in a channel | Anthropic cloud |
| Claude Code on the web / `--cloud` | Start a cloud session | Anthropic cloud |
| Self-hosted environments | Cloud session on your runners | Your infrastructure |
| Scheduled tasks / routines | Cron | CLI, Desktop, or cloud |

Background sessions are a separate local axis: `claude --bg`, then `claude agents`,
`attach`, `logs`, `stop`, `rm`, `respawn`.

### The programmatic control channel

The only open, documented-ish way to drive Claude Code as a harness:

```
claude --output-format stream-json --input-format stream-json --verbose \
       --permission-prompt-tool stdio
```

NDJSON both ways, one process kept alive with stdin open. Carries
`control_request`/`control_response` pairs with `request_id` and a `behavior` field
(e.g. `deny`) for tool approval, plus `mcp_message`/`mcp_response` for SDK MCP servers.
Without `--permission-prompt-tool stdio`, tools auto-deny in non-interactive mode.

**This is stdio-local and vendor-specific.** It is the natural HCP adapter point for
Claude Code, and it works today without vendor cooperation.

## 3. How Codex does remote

Codex's design is much closer to what HCP wants to be — and it is self-describing.

### `codex app-server` — the actual protocol

JSON-RPC 2.0 with formal `JSONRPCRequest` / `JSONRPCResponse` / `JSONRPCNotification` /
`JSONRPCError` schemas. Transport is **pluggable at the CLI**:

```
codex app-server --listen stdio://        # default
                 --listen unix://PATH
                 --listen ws://IP:PORT
                 --listen off
```

Non-loopback WebSocket listeners get a real auth story:

```
--ws-auth capability-token | signed-bearer-token
--ws-token-file PATH  --ws-token-sha256 HEX
--ws-shared-secret-file PATH  --ws-issuer ISS  --ws-audience AUD
--ws-max-clock-skew-seconds N
```

The protocol is machine-readable and versioned (`v1`/`v2` namespaces):

```
codex app-server generate-json-schema --out DIR
codex app-server generate-ts --out DIR
```

**Measured surface** (codex-cli 0.150.1, extracted locally): **95** client requests,
**10** server→client requests, **79** server notifications, **1** client notification.

Client requests, by family:

- Lifecycle: `initialize`
- Threads: `thread/start`, `thread/resume`, `thread/fork`, `thread/list`,
  `thread/read`, `thread/archive`, `thread/rollback`, `thread/compact/start`,
  `thread/goal/{get,set,clear}`, `thread/name/set`, `thread/inject_items`,
  `threadSection/{create,update,delete,list}`
- Turns: `turn/start`, `turn/interrupt`, **`turn/steer`**
- Exec: `command/exec`, `command/exec/{write,resize,terminate}`
- Filesystem: `fs/{readFile,writeFile,readDirectory,createDirectory,copy,remove,getMetadata,watch,unwatch}`, `fuzzyFileSearch`
- Ecosystem: `mcpServer/tool/call`, `mcpServer/resource/read`, `mcpServerStatus/list`,
  `plugin/*`, `skills/*`, `marketplace/*`, `model/list`, `config/*`, `review/start`,
  `account/*`, `permissionProfile/list`, `externalAgentConfig/{detect,import}`

Server→client requests — **the approval channel**, and the part any HCP design lives
or dies on:

```
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
item/tool/call
item/tool/requestUserInput
mcpServer/elicitation/request
applyPatchApproval        execCommandApproval        (v1 legacy)
attestation/generate      account/chatgptAuthTokens/refresh
```

Server notifications cover streaming deltas (`item/agentMessage/delta`,
`item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/plan/delta`),
lifecycle (`thread/started`, `turn/started`, `turn/completed`, `item/started`,
`item/completed`, `thread/status/changed`, `thread/tokenUsage/updated`), and notably
**`remoteControl/status/changed`** — remote control is a first-class protocol concept,
not a bolt-on. There is even in-protocol WebRTC signaling: `thread/realtime/sdp`,
`thread/realtime/outputAudio/delta`, `thread/realtime/transcript/delta`.

### Daemon and remote control

```
codex app-server daemon start|restart|stop|version
codex app-server daemon bootstrap                  # durable local mgmt for SSH-driven use
codex app-server daemon enable-remote-control|disable-remote-control
codex app-server proxy                             # proxy stdio to the control socket

codex remote-control start|stop
codex remote-control pair                          # short-lived manual pairing code
codex agents                                       # browse sessions on the shared daemon
```

**The key architectural idea:** the TUI is just another client.

```
codex --remote ws://host:port --remote-auth-token-env VAR
codex --remote wss://host:port
codex --remote unix://PATH
```

Same for `codex agents --remote ...`. There is no privileged local path — the local
terminal and a remote phone are peers on the same protocol. If HCP borrows one thing
from Codex, borrow this.

### Product surface

Codex in the ChatGPT mobile app (iOS + Android, shipped May 14 2026, GA June 25 2026).
No standalone app. Codex for Mac shows a QR code; you scan it from ChatGPT to pair. A
"secure relay layer keeps trusted machines reachable across your authorized ChatGPT
devices without exposing them directly to the public internet." Remote dev environments
use SSH to start and manage the remote Codex app server. Host support is macOS-only,
Windows listed as coming.

The docs carry an explicit warning worth quoting in the HCP threat model: **"Don't
expose app-server transports directly on a shared or public network."**

Adjacent: `codex mcp-server` (Codex as an MCP server — coarse-grained, one tool),
`codex cloud` (Codex Cloud tasks: exec/status/list/apply/diff), `codex exec-server`.

## 4. What this means for HCP

### The convergent architecture

Both vendors independently landed on the same seven pieces. Treat these as the
requirements list:

1. A long-lived local **daemon / session host** owning the agent processes
2. A **bidirectional JSON-RPC-ish stream**, where the *harness asks the client*
   questions (approvals, elicitation) — not a request/response API
3. **Outbound-only or relayed** connectivity, because phones cannot reach laptops
4. **Short-lived, narrowly-scoped credentials** plus device pairing (QR / pairing code)
5. **Multi-client attach** to one session with state sync across surfaces
6. **Push notification** as a first-class protocol event
7. **Reconnect / resume** against a durable session record

### Where they differ (what a standard must reconcile)

| | Claude Code | Codex |
|---|---|---|
| Wire protocol | Undocumented for remote; stdio `stream-json` is the only open channel | Explicit JSON-RPC 2.0, schema-generated, versioned v1/v2 |
| Transport | Vendor relay only (`api.anthropic.com`) | `stdio` / `unix` / `ws` — self-hostable, plus vendor relay |
| Local vs remote clients | Terminal is privileged; remote is a separate mode | TUI is just a client (`--remote`) |
| Auth | claude.ai full-scope login; no API keys; no gateways | Capability token or signed JWT; issuer/audience/skew configurable |
| Enterprise | Rich: admin toggle, Trusted Devices, compliance gates | Lighter; SSH-oriented for remote hosts |

### Where HCP has genuine room

- **A vendor-neutral relay / rendezvous spec.** Claude's relay is Anthropic-only;
  Codex's is OpenAI-only. The phone→laptop NAT-traversal problem is unsolved in the
  open, and it is the single hardest part to get right. This is the highest-value
  piece of HCP.
- **Session attach semantics.** ACP is stdio-local; UHP is task-shaped HTTP. Nobody
  specifies N remote clients attaching to one live session with consistent state.
- **A common approval envelope.** Both harnesses have rich, mutually incompatible
  approval payloads. Normalizing "the agent wants to run X, here is the diff/command,
  answer yes/no/always" is the interop problem that actually matters on a phone.
- **Capability negotiation** across harnesses with genuinely different feature sets.

### Design recommendation

HCP ≈ **ACP's method vocabulary + Codex app-server's transport/auth model + a
vendor-neutral relay and pairing spec.**

Reusing ACP's names (`session/new`, `session/prompt`, `session/update`,
`session/request_permission`, `fs/*`, `terminal/*`) means every existing ACP client and
adapter bridges to HCP nearly for free, and it avoids relitigating a vocabulary that
two IDE vendors already shipped. The novel contribution is the layer ACP explicitly
has not built: transport, multi-client attach, relay, pairing, and reconnect.

Ship-first conformance targets, both reachable today without vendor cooperation:

- **Codex adapter** — `codex app-server --listen ws://` is already the shape HCP wants.
- **Claude Code adapter** — `claude --output-format stream-json --input-format
  stream-json --permission-prompt-tool stdio`, wrapped in the HCP transport.

Prove the standard by making a single mobile client drive both without tmux.

## 5. On the name

Originally **HTP — Harness Transport Protocol**. Renamed to **HCP — Harness Control
Protocol** on 2026-09-02. The reasoning, kept because it constrains future naming:

- **"Transport" named the wrong layer.** A transport moves bytes: TCP, WebSocket, stdio.
  Codex already has three. What this spec describes is what rides on top — session attach,
  approval round-trips, pairing, reconnect. That is a control plane.
- **"HTP" was one keystroke from HTTP** — a permanent tax on search, speech, and every code
  review where `htp://` looks like a typo.
- **The neighbourhood was occupied.** UHP (Unified Harness Protocol) already sits in this
  space; HTP vs UHP was a collision waiting to happen.
- **"Control" is the vendors' own word** — `claude remote-control`, `codex remote-control`,
  `remoteControl/status/changed` — so the name lands in vocabulary the audience has.

"Harness" was kept: it is the emerging term of art and it distinguishes this from "agent,"
which ACP and A2A have claimed. Residual risk to watch: harness.io is an established CI/CD
company. If a trademark question ever blocks the name, the fallback on file is **ASCP —
Agent Session Control Protocol**, at the cost of losing the term of art.
