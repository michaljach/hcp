/**
 * The Host<->Harness contract.
 *
 * `host.ts` depends on this and never on a concrete driver, which is what lets the
 * same host.ts serve Claude Code and Codex unchanged. Each adapter's smoke test
 * asserts this file is byte-identical across adapters.
 */

import type { PermissionOption } from "./types.ts";

export interface HarnessEvent {
  kind: string;
  [k: string]: unknown;
}

export interface PermissionAsk {
  harnessRequestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface HarnessCapabilities {
  steer: boolean; interrupt: boolean; replay: boolean; snapshot: boolean;
  lease: boolean; fork: boolean; rollback: boolean; diff: boolean;
  terminal: boolean; push: boolean;
  permission_kinds: string[];
  permission_scopes: string[];
  fs: { read: boolean; write: boolean; watch: boolean };
  [k: string]: unknown;
}

export interface Harness {
  readonly name: string;
  readonly version: string;
  start(): Promise<void>;
  prompt(text: string): void;
  interrupt(): void;
  /** What this harness can do. Returned verbatim from HCP `initialize`. */
  capabilities(): HarnessCapabilities;
  /** Present only when the harness can course-correct without ending the turn. */
  steer?(text: string): void;
  /** The decisions this harness can actually honor. Advertised means callable. */
  permissionOptions(): PermissionOption[];
  answerPermission(id: string, optionId: string, message?: string): void;
  stop(): void;
  onEvent(cb: (e: HarnessEvent) => void): void;
  onPermission(cb: (p: PermissionAsk) => void): void;
  onTurnEnd(cb: () => void): void;
}
