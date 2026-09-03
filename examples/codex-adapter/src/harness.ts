/**
 * Codex app-server driver.
 *
 * The only file in this adapter that Codex-specific knowledge lives in. `host.ts`,
 * `classify.ts` and `types.ts` are byte-identical to the Claude Code adapter's, and the
 * smoke test asserts it — that identity is the spec's harness-independence claim made
 * checkable rather than asserted.
 *
 * The trick that keeps `classify.ts` shared: Codex delivers approvals already
 * structured (`command`, `cwd`, `reason`) rather than as an opaque tool blob, so this
 * driver normalizes them into the same {toolName, input} shape the classifier already
 * grades. Risk grading is universal; only payload mapping is per-harness.
 *
 * NOTE ON STABILITY: shapes below are codex-cli 0.150.x, taken from
 * `codex app-server generate-json-schema`. Confined to this file so drift has one home.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { PermissionOption } from "./types.ts";
import type { Harness, HarnessCapabilities, HarnessEvent, PermissionAsk } from "./shared.ts";

/** Codex honors deny-and-interrupt, which Claude Code has no equivalent for. */
const CODEX_OPTIONS: PermissionOption[] = [
  { id: "allow_once", label: "Allow", kind: "allow", scope: "once" },
  { id: "allow_session", label: "Allow for this session", kind: "allow", scope: "session" },
  { id: "reject_once", label: "Deny", kind: "reject", scope: "once" },
  { id: "reject_cancel", label: "Deny and stop the turn", kind: "reject", scope: "once" },
];

/** HCP option id -> Codex approval decision. */
const DECISION: Record<string, string> = {
  allow_once: "accept",
  allow_session: "acceptForSession",
  reject_once: "decline",
  reject_cancel: "cancel",
};

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

abstract class Base implements Harness {
  abstract readonly name: string;
  abstract readonly version: string;
  protected evCb: (e: HarnessEvent) => void = () => {};
  protected permCb: (p: PermissionAsk) => void = () => {};
  protected endCb: () => void = () => {};
  onEvent(cb: (e: HarnessEvent) => void) { this.evCb = cb; }
  onPermission(cb: (p: PermissionAsk) => void) { this.permCb = cb; }
  onTurnEnd(cb: () => void) { this.endCb = cb; }
  permissionOptions(): PermissionOption[] { return CODEX_OPTIONS; }

  capabilities(): HarnessCapabilities {
    // Codex carries the richer surface of the two: turn/steer, thread/fork and
    // thread/rollback all exist, so unlike the Claude Code adapter these are true.
    return {
      steer: true, interrupt: true, replay: true, snapshot: true,
      lease: false, fork: true, rollback: true, diff: true,
      terminal: true, push: false,
      permission_kinds: ["exec", "write", "tool", "network", "elicit"],
      permission_scopes: ["once", "session"],
      fs: { read: true, write: true, watch: true },
    };
  }
  abstract start(): Promise<void>;
  abstract prompt(text: string): void;
  abstract interrupt(): void;
  abstract answerPermission(id: string, optionId: string, message?: string): void;
  abstract stop(): void;
}

export class CodexHarness extends Base {
  readonly name = "codex";
  version = "unknown";
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cwd: string;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private nextId = 1;
  private waiting = new Map<string, (result: any) => void>();
  /** HCP request id -> the JSON-RPC id Codex is blocking on. */
  private approvals = new Map<string, string | number>();

  constructor(cwd: string) { super(); this.cwd = cwd; }

  async start(): Promise<void> {
    this.proc = spawn("codex", ["app-server", "--listen", "stdio://"],
                      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try { this.handle(JSON.parse(line)); } catch { /* ignore malformed frames */ }
    });
    this.proc.stderr.on("data", (b: Buffer) => process.stderr.write(`[codex] ${b}`));
    this.proc.on("exit", (code) =>
      this.evCb({ kind: "error", text: `codex app-server exited with code ${code}` }));

    const init = await this.call("initialize",
      { clientInfo: { name: "hcp-codex", version: "0.1.0", title: "HCP adapter" } });
    this.version = init?.userAgent ?? init?.serverInfo?.version ?? "unknown";
    this.notify("initialized", {});

    const thread = await this.call("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    this.threadId = thread?.threadId ?? thread?.thread?.id ?? null;
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = `a${this.nextId++}`;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.write({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (this.waiting.delete(id)) resolve(null); }, 30_000);
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(o: unknown) { this.proc?.stdin.write(JSON.stringify(o) + "\n"); }

  private handle(m: any): void {
    // Response to something we sent.
    if (m.id !== undefined && m.method === undefined) {
      const w = this.waiting.get(String(m.id));
      if (w) { this.waiting.delete(String(m.id)); w(m.result ?? null); }
      return;
    }

    // Server -> client request: the approval channel.
    if (m.id !== undefined && APPROVAL_METHODS.has(m.method)) {
      const p = m.params ?? {};
      const hcpId = String(p.approvalId ?? p.itemId ?? m.id);
      this.approvals.set(hcpId, m.id);
      this.permCb({ harnessRequestId: hcpId, ...normalize(m.method, p) });
      return;
    }

    // Notifications.
    const p = m.params ?? {};
    switch (m.method) {
      case "turn/started": this.turnId = p.turnId ?? this.turnId; return;
      case "item/agentMessage/delta":
        return this.evCb({ kind: "agent_message_delta", text: p.delta ?? p.text ?? "" });
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return this.evCb({ kind: "reasoning_delta", text: p.delta ?? p.text ?? "" });
      case "item/commandExecution/outputDelta":
        return this.evCb({ kind: "command_output_delta", text: p.delta ?? p.chunk ?? "" });
      case "item/plan/delta":
      case "turn/plan/updated":
        return this.evCb({ kind: "plan", plan: p.plan ?? p });
      case "item/fileChange/patchUpdated":
        return this.evCb({ kind: "file_change", patch: p });
      case "turn/diff/updated":
        return this.evCb({ kind: "diff_summary", diff: p.diff ?? p });
      case "thread/tokenUsage/updated":
        return this.evCb({ kind: "token_usage", ...p });
      case "item/started":
        return this.evCb({ kind: "tool_call", item: p.item ?? p });
      case "item/completed":
        return this.evCb({ kind: "tool_result", item: p.item ?? p });
      case "turn/completed":
        this.turnId = null;
        return this.endCb();
      case "error":
        return this.evCb({ kind: "error", text: p.message ?? "codex error" });
    }
  }

  prompt(text: string): void {
    if (!this.threadId) return;
    this.notify("turn/start", { threadId: this.threadId, input: [{ type: "text", text }] });
  }

  /** turn/steer — a mid-turn course correction with no equivalent in Claude Code. */
  steer(text: string): void {
    if (!this.threadId || !this.turnId) return;
    this.notify("turn/steer", { threadId: this.threadId, turnId: this.turnId,
                                input: [{ type: "text", text }] });
  }

  interrupt(): void {
    if (this.threadId && this.turnId)
      this.notify("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  answerPermission(id: string, optionId: string, _message?: string): void {
    const rpcId = this.approvals.get(id);
    if (rpcId === undefined) return;
    this.approvals.delete(id);
    this.write({ jsonrpc: "2.0", id: rpcId,
                 result: { decision: DECISION[optionId] ?? "decline" } });
  }

  stop(): void { this.proc?.kill("SIGTERM"); this.proc = null; }
}

/**
 * Codex's typed approval params -> the {toolName, input} shape classify.ts grades.
 */
function normalize(method: string, p: any): { toolName: string; input: Record<string, unknown> } {
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval")
    return { toolName: "Edit",
             input: { file_path: p.grantRoot ?? p.path ?? "(patch)",
                      description: p.reason, old_string: "", new_string: "" } };

  if (method === "item/permissions/requestApproval")
    return { toolName: "PermissionProfile",
             input: { permissions: p.permissions, cwd: p.cwd, description: p.reason } };

  // commandExecution / execCommandApproval
  const command = p.command ?? (Array.isArray(p.commandActions)
    ? p.commandActions.map((a: any) => a?.command).filter(Boolean).join(" && ")
    : "");
  return { toolName: "Bash",
           input: { command, cwd: p.cwd, description: p.reason } };
}

/** Scripted Codex for tests: no binary, no tokens, same wire semantics. */
export class MockCodexHarness extends Base {
  readonly name = "codex";
  readonly version = "0.150.1-mock";
  private pending: string | null = null;
  private n = 0;
  lastDecision: string | null = null;

  async start(): Promise<void> {}

  steer(text: string): void { this.evCb({ kind: "agent_message_delta", text: `steered: ${text}` }); }

  prompt(_t: string): void {
    this.evCb({ kind: "reasoning_delta", text: "Checking the migration setup." });
    this.pending = `codex_appr_${++this.n}`;
    setTimeout(() => this.permCb({
      harnessRequestId: this.pending as string,
      ...normalize("item/commandExecution/requestApproval", {
        command: "npm run migrate:dev", cwd: process.cwd(),
        reason: "Apply pending migrations",
      }),
    }), 5);
  }

  interrupt(): void { this.endCb(); }

  answerPermission(_id: string, optionId: string): void {
    this.lastDecision = DECISION[optionId] ?? "decline";
    this.pending = null;
    this.evCb({ kind: "agent_message_delta",
                text: `Codex decision: ${this.lastDecision}` });
    this.evCb({ kind: "token_usage", input_tokens: 900, output_tokens: 40 });
    setTimeout(() => this.endCb(), 5);
  }

  stop(): void {}
}
