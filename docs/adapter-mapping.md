# Adapter mapping — Claude Code and Codex

Concrete translation for the two conformance targets. Both are reachable today with no
vendor cooperation, which is the reason the spec is shaped the way it is.

Versions surveyed: Claude Code `2.1.258`, codex-cli `0.150.1`.

## 1. Codex

> Implemented: [`examples/codex-adapter/`](../examples/codex-adapter) — covers everything in
> this section except the `ws://` transport, which is a change to one method.

Codex is the easy one. `codex app-server` is already JSON-RPC 2.0 with pluggable transports
and a generated schema; the adapter is largely renaming plus the parts HCP adds.

```bash
codex app-server --listen ws://127.0.0.1:7699 \
                 --ws-auth capability-token --ws-token-file /run/hcp/token
```

### Method mapping

| HCP | Codex app-server |
|---|---|
| `initialize` | `initialize` |
| `host/sessions/list` | `thread/list`, `thread/loaded/list` |
| `host/sessions/create` | `thread/start` |
| `host/sessions/close` | `thread/archive` |
| `session/attach` | `thread/resume` + subscribe |
| `session/detach` | `thread/unsubscribe` |
| `session/prompt` | `turn/start` |
| `session/steer` | `turn/steer` |
| `session/interrupt` | `turn/interrupt` |
| `session/snapshot` | `thread/read` |
| `fs/read_text_file` | `fs/readFile` |
| `fs/write_text_file` | `fs/writeFile` |
| `fs/diff` | `turn/diff/updated` (cached by the adapter) |
| `terminal/create` | `command/exec` |
| `terminal/output` | `command/exec/outputDelta` |
| `terminal/kill` | `command/exec/terminate` |

### Permission mapping

| HCP `action.kind` | Codex server request |
|---|---|
| `exec` | `item/commandExecution/requestApproval`, `execCommandApproval` (v1) |
| `write` | `item/fileChange/requestApproval`, `applyPatchApproval` (v1) |
| `tool` | `item/permissions/requestApproval` |
| `elicit` | `item/tool/requestUserInput`, `mcpServer/elicitation/request` |

### Event mapping

| HCP `update.kind` | Codex notification |
|---|---|
| `agent_message_delta` | `item/agentMessage/delta` |
| `reasoning_delta` | `item/reasoning/textDelta`, `item/reasoning/summaryTextDelta` |
| `plan` | `item/plan/delta`, `turn/plan/updated` |
| `command_output_delta` | `item/commandExecution/outputDelta` |
| `file_change` | `item/fileChange/patchUpdated` |
| `diff_summary` | `turn/diff/updated` |
| `token_usage` | `thread/tokenUsage/updated` |
| `tool_call` / `tool_result` | `item/started` / `item/completed` |

### Notes

- **`seq` must be synthesized.** Codex notifications are not globally sequenced per thread.
  The adapter assigns `seq` as it forwards, and owns the event log. This is the main piece of
  real work in the adapter.
- **`remoteControl/status/changed`** has no HCP equivalent and should not get one — HCP
  models remote control as the normal case rather than a mode.
- **Realtime/voice** (`thread/realtime/*`, WebRTC SDP) is out of scope for HCP v0.1.
- Capabilities: `steer: true`, `fork: true`, `rollback: true`, `terminal: true`.

## 2. Claude Code

> Implemented: [`examples/claude-code-adapter/`](../examples/claude-code-adapter) — a
> working, zero-dependency Host covering everything in this section except the `ws://` and
> `relay://` transports.

Harder, because there is no public remote wire format. The adapter drives the documented
stdio control protocol and provides everything above it.

```bash
claude --output-format stream-json --input-format stream-json --verbose \
       --permission-prompt-tool stdio
```

NDJSON both directions over one long-lived process with stdin held open. Without
`--permission-prompt-tool stdio`, tools auto-deny in non-interactive mode and the approval
channel does not exist.

### Method mapping

| HCP | Claude Code |
|---|---|
| `initialize` | Process spawn + `--session-id`, capability set is static per adapter version |
| `host/sessions/list` | `claude agents`, plus adapter-owned registry |
| `host/sessions/create` | Spawn a new CLI process |
| `session/attach` | Adapter-side; the CLI has no attach concept |
| `session/prompt` | Write a user message to stdin |
| `session/interrupt` | Interrupt control request |
| `session/snapshot` | Adapter's materialized log |
| `fs/diff` | `git diff` computed Host-side, as Claude Code's own diff pane does |
| `terminal/*` | Not exposed — advertise `terminal: false` |

### Permission mapping

Claude Code sends one `control_request` carrying the tool name and input. The adapter must
classify it into an HCP `action.kind` and **generate the `summary` and `risk` itself** —
`Bash` → `exec`, `Edit`/`Write` → `write`, `WebFetch` → `network`, MCP tools → `tool`.

The response is a `control_response` with a `behavior` field, mapped from the chosen
`option.kind`.

This is where the adapter earns its keep. Claude Code's payload assumes a terminal is
rendering it; turning `{"tool":"Bash","input":{"command":"npm run migrate:dev"}}` into
*"Run database migrations against the dev database"* with `risk: "high"` is the work that
makes the request answerable on a phone.

### Notes

- **`steer` is unavailable.** Advertise `steer: false`; clients queue a prompt instead.
- **`seq` is adapter-assigned**, same as Codex.
- Claude Code's own Remote Control needs a claude.ai subscription, rejects API keys, and
  refuses to work through Bedrock, Vertex, or a custom `ANTHROPIC_BASE_URL`. **The HCP
  adapter has none of those constraints**, because it uses the local process rather than
  Anthropic's relay. For gateway and cloud-provider deployments this is not merely an
  alternative — it is the only remote-control path that works at all.

## 3. What the adapters share

This was a prediction when the spec was written. Both adapters are now built, and it held
better than expected — the shared portion is **byte-identical**, asserted on every test run:

| File | Contents | Shared? |
|---|---|---|
| `host.ts` | Sessions, `seq` log, retention, replay, fan-out, permission broadcast | identical |
| `shared.ts` | The Host↔Harness contract | identical |
| `classify.ts` | Risk grading and summary generation | identical |
| `types.ts` | HCP wire types | identical |
| `harness.ts` | Transport to the harness, payload mapping, decision mapping | **per-harness** |

So the revision to the original claim: it is not three things that are per-harness, it is
**one file**. Two design choices bought that.

**Risk grading is universal.** A force-push is dangerous regardless of which harness
proposed it. Codex delivers approvals already structured where Claude Code sends an opaque
tool blob, so rather than fork the classifier, the Codex driver normalizes its typed params
into the shape the classifier already grades. Only payload mapping is per-harness.

**Capabilities and permission options come from the harness, not the host.** Codex advertises
`steer`, `fork`, `rollback` and `terminal`; Claude Code advertises none of them. Codex offers
`reject_cancel` (deny and interrupt the turn) and must *not* offer `reject_feedback`, because
its `decline` decision carries no message field — a client would render a text box whose
contents went nowhere. Claude Code is the mirror image. Had either been hardcoded in
`host.ts`, the file could not be shared.

Still unbuilt in both, and specified: `ws://` and `relay://` transports, device roster and
pairing, the Noise channel, leases, and push.
