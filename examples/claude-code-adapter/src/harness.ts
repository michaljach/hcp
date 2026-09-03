/**
 * Harness drivers.
 *
 * `ClaudeCodeHarness` drives the real CLI over its stream-json control protocol.
 * `MockHarness` replays a scripted run so the adapter is testable without burning
 * tokens or requiring a logged-in CLI.
 *
 * NOTE ON STABILITY: the stream-json envelope shapes below are Claude Code 2.1.x and
 * are not a published standard. They are deliberately confined to this one file so
 * that when they drift, exactly one thing needs fixing.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface HarnessEvent {
  kind: string;
  [k: string]: unknown;
}

export interface PermissionAsk {
  harnessRequestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface Harness {
  readonly name: string;
  readonly version: string;
  start(): Promise<void>;
  prompt(text: string): void;
  interrupt(): void;
  answerPermission(id: string, allow: boolean, message?: string): void;
  stop(): void;
  onEvent(cb: (e: HarnessEvent) => void): void;
  onPermission(cb: (p: PermissionAsk) => void): void;
  onTurnEnd(cb: () => void): void;
}

abstract class BaseHarness implements Harness {
  abstract readonly name: string;
  abstract readonly version: string;
  protected evCb: (e: HarnessEvent) => void = () => {};
  protected permCb: (p: PermissionAsk) => void = () => {};
  protected endCb: () => void = () => {};
  onEvent(cb: (e: HarnessEvent) => void) { this.evCb = cb; }
  onPermission(cb: (p: PermissionAsk) => void) { this.permCb = cb; }
  onTurnEnd(cb: () => void) { this.endCb = cb; }
  abstract start(): Promise<void>;
  abstract prompt(text: string): void;
  abstract interrupt(): void;
  abstract answerPermission(id: string, allow: boolean, message?: string): void;
  abstract stop(): void;
}

export class ClaudeCodeHarness extends BaseHarness {
  readonly name = "claude-code";
  version = "unknown";
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cwd: string;

  constructor(cwd: string) { super(); this.cwd = cwd; }

  async start(): Promise<void> {
    // The four flags that make the CLI drivable. Without --permission-prompt-tool
    // stdio there is no approval channel at all and tools auto-deny.
    this.proc = spawn("claude", [
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--permission-prompt-tool", "stdio",
    ], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });

    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try { this.handle(JSON.parse(line)); }
      catch { this.evCb({ kind: "warning", text: `unparseable harness line: ${line.slice(0, 200)}` }); }
    });

    // stderr is logs, never protocol. Spec: transport.md §2.1.
    this.proc.stderr.on("data", (b: Buffer) =>
      process.stderr.write(`[claude] ${b.toString()}`));

    this.proc.on("exit", (code) =>
      this.evCb({ kind: "error", text: `harness exited with code ${code}` }));
  }

  private handle(msg: Record<string, any>): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.version = msg.version ?? "unknown";
        return;

      case "control_request": {
        const r = msg.request ?? {};
        if (r.subtype === "can_use_tool") {
          this.permCb({
            harnessRequestId: String(msg.request_id),
            toolName: String(r.tool_name ?? "unknown"),
            input: (r.input ?? {}) as Record<string, unknown>,
          });
        }
        return;
      }

      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text")
            this.evCb({ kind: "agent_message_delta", text: block.text });
          else if (block.type === "thinking")
            this.evCb({ kind: "reasoning_delta", text: block.thinking });
          else if (block.type === "tool_use")
            this.evCb({ kind: "tool_call", tool: block.name, arguments: block.input });
        }
        return;
      }

      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_result")
            this.evCb({ kind: "tool_result", output: block.content });
        }
        return;
      }

      case "result":
        this.evCb({
          kind: "token_usage",
          input_tokens: msg.usage?.input_tokens ?? 0,
          output_tokens: msg.usage?.output_tokens ?? 0,
          cost_usd: msg.total_cost_usd ?? null,
        });
        this.endCb();
        return;
    }
  }

  private write(o: unknown): void { this.proc?.stdin.write(JSON.stringify(o) + "\n"); }

  prompt(text: string): void {
    this.write({ type: "user", message: { role: "user", content: text } });
  }

  interrupt(): void {
    this.write({ type: "control_request", request_id: `int_${Date.now()}`,
                 request: { subtype: "interrupt" } });
  }

  answerPermission(id: string, allow: boolean, message?: string): void {
    this.write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: allow ? { behavior: "allow" } : { behavior: "deny", message: message ?? "" },
      },
    });
  }

  stop(): void { this.proc?.kill("SIGTERM"); this.proc = null; }
}

/** Deterministic scripted harness. Exercises every path without a real CLI. */
export class MockHarness extends BaseHarness {
  readonly name = "mock";
  readonly version = "0.1.0";
  private pending: string | null = null;
  private n = 0;

  async start(): Promise<void> {}

  prompt(_text: string): void {
    this.evCb({ kind: "agent_message_delta", text: "Looking at the migration setup." });
    this.pending = `mock_perm_${++this.n}`;
    setTimeout(() => this.permCb({
      harnessRequestId: this.pending as string,
      toolName: "Bash",
      input: { command: "npm run migrate:dev", cwd: process.cwd(),
               description: "Apply pending migrations" },
    }), 5);
  }

  interrupt(): void { this.endCb(); }

  answerPermission(_id: string, allow: boolean, message?: string): void {
    this.pending = null;
    this.evCb(allow
      ? { kind: "agent_message_delta", text: "Migration applied." }
      : { kind: "agent_message_delta", text: `Understood — ${message ?? "skipping"}.` });
    this.evCb({ kind: "token_usage", input_tokens: 1200, output_tokens: 64, cost_usd: 0.004 });
    setTimeout(() => this.endCb(), 5);
  }

  stop(): void {}
}
