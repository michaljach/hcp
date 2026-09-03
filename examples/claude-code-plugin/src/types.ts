/**
 * HCP v0.1 wire types — the subset this adapter implements.
 * Mirrors schema/hcp-v0.1.schema.json. Kept hand-written rather than generated
 * so the example stays dependency-free.
 */

export const HCP_VERSION = "0.1";

export type RiskLevel = "low" | "medium" | "high";
export type PermissionKind = "exec" | "write" | "tool" | "network" | "elicit";
export type PermissionScope = "once" | "session" | "always";
export type SessionState =
  | "starting" | "idle" | "working" | "awaiting_input" | "suspended" | "ended";

export interface Envelope {
  jsonrpc: "2.0";
  hcp: string;
}

export interface Request extends Envelope {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface Notification extends Envelope {
  method: string;
  params?: Record<string, unknown>;
}

export interface Response extends Envelope {
  id: string;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: { retry_after_ms?: number; [k: string]: unknown };
}

/** Error codes from spec/v0.1/transport.md §6. */
export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthorized: -32001,
  notInitialized: -32002,
  sessionNotFound: -32003,
  replayUnavailable: -32004,
  capabilityUnsupported: -32005,
  leased: -32006,
  permissionExpired: -32007,
  versionUnsupported: -32008,
} as const;

export interface PermissionAction {
  kind: PermissionKind | string;
  /** REQUIRED. One line, imperative, <= 120 chars, no markup. */
  summary: string;
  risk: RiskLevel;
  reversible?: boolean;
  detail?: Record<string, unknown>;
}

export interface PermissionOption {
  id: string;
  label: string;
  kind: "allow" | "reject";
  scope: PermissionScope;
  accepts_text?: boolean;
}

export interface RequestPermissionParams {
  session_id: string;
  seq: number;
  action: PermissionAction;
  options: PermissionOption[];
  expires_at: string;
}

export interface SessionUpdate {
  kind: string;
  [k: string]: unknown;
}

export interface SessionEvent {
  session_id: string;
  seq: number;
  replayed?: boolean;
  origin?: { client_id?: string; device_id?: string };
  update: SessionUpdate;
}
