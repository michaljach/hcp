/**
 * The HCP Host.
 *
 * Owns sessions, the per-session event log and its `seq` counter, the device-agnostic
 * client fan-out, and the permission broadcast. Everything in this file is harness
 * independent — swapping Claude Code for Codex changes `harness.ts` and `classify.ts`
 * and nothing here. That split is the point of the spec.
 */

import { randomUUID } from "node:crypto";
import { classify } from "./classify.ts";
import { HCP_VERSION, ERR } from "./types.ts";
import type { Harness, PermissionAsk, HarnessEvent } from "./shared.ts";
import type {
  SessionEvent, SessionState, PermissionOption, RpcError,
} from "./types.ts";

/** spec/v0.1/sessions.md §2 — retain 10,000 events or 24h, whichever comes first. */
const MAX_EVENTS = 10_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PERMISSION_TTL_MS = 120_000;

/**
 * Options come from the harness, not from here. Codex can deny-and-interrupt where
 * Claude Code can only deny, and a client must be offered what the harness can
 * actually honor -- spec/v0.1/capabilities.md: advertised means callable.
 */
function optionsFor(s: Session): PermissionOption[] {
  return s.harness.permissionOptions();
}

/** On expiry, spec/v0.1/permissions.md requires the most restrictive reject. */
function mostRestrictiveReject(opts: PermissionOption[]): string | null {
  const rejects = opts.filter((o) => o.kind === "reject");
  if (!rejects.length) return null;
  return (rejects.find((o) => o.id === "reject_cancel") ?? rejects[rejects.length - 1]).id;
}

export interface Client {
  id: string;
  deviceId?: string;
  send(msg: unknown): void;
  /** sessionId -> whether attached. Cursors live client-side; the host only fans out. */
  attached: Set<string>;
  formFactor?: string;
}

interface Pending {
  hcpRequestId: string;
  harnessRequestId: string;
  timer: NodeJS.Timeout;
  resolved: boolean;
}

interface Session {
  id: string;
  cwd: string;
  name: string;
  state: SessionState;
  seq: number;
  oldestSeq: number;
  log: Array<SessionEvent & { at: number }>;
  pending: Map<string, Pending>;
  allowAlways: Set<string>;
  harness: Harness;
}

export class HcpHost {
  private sessions = new Map<string, Session>();
  private clients = new Set<Client>();
  private makeHarness: (cwd: string) => Harness;

  constructor(makeHarness: (cwd: string) => Harness) {
    this.makeHarness = makeHarness;
  }

  // ---------------------------------------------------------------- sessions

  async createSession(cwd: string, name?: string): Promise<Session> {
    const harness = this.makeHarness(cwd);
    const s: Session = {
      id: `s_${randomUUID().slice(0, 8)}`,
      cwd,
      name: name ?? cwd.split("/").pop() ?? "session",
      state: "starting",
      seq: 0,
      oldestSeq: 1,
      log: [],
      pending: new Map(),
      allowAlways: new Set(),
      harness,
    };
    this.sessions.set(s.id, s);

    harness.onEvent((e: HarnessEvent) => this.emit(s, e));
    harness.onPermission((p: PermissionAsk) => this.askPermission(s, p));
    harness.onTurnEnd(() => this.setState(s, "idle"));

    await harness.start();
    this.setState(s, "idle");
    return s;
  }

  private get(id: unknown): Session {
    const s = this.sessions.get(String(id));
    if (!s) throw rpc(ERR.sessionNotFound, `no such session: ${id}`);
    return s;
  }

  // ------------------------------------------------------------- event log

  /** Assigns `seq`, appends to the log, fans out to every attached client. */
  private emit(s: Session, update: HarnessEvent, origin?: SessionEvent["origin"]): number {
    const ev: SessionEvent & { at: number } = {
      session_id: s.id,
      seq: ++s.seq,
      update,
      at: Date.now(),
      ...(origin ? { origin } : {}),
    };
    s.log.push(ev);
    this.trim(s);
    this.broadcast(s, "session/update", stripAt(ev));
    return ev.seq;
  }

  private trim(s: Session): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    while (s.log.length > MAX_EVENTS || (s.log.length && s.log[0].at < cutoff)) {
      const dropped = s.log.shift();
      if (dropped) s.oldestSeq = dropped.seq + 1;
    }
  }

  private setState(s: Session, state: SessionState): void {
    if (s.state === state) return;
    s.state = state;
    this.broadcast(s, "session/state", { session_id: s.id, state, seq: s.seq });
  }

  private broadcast(s: Session, method: string, params: unknown): void {
    for (const c of this.clients)
      if (c.attached.has(s.id))
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method, params });
  }

  // ----------------------------------------------------------- permissions

  private askPermission(s: Session, p: PermissionAsk): void {
    const action = classify(p.toolName, p.input, s.cwd);

    // "Allow for this session" already granted for this tool -> don't re-ask.
    if (s.allowAlways.has(p.toolName)) {
      s.harness.answerPermission(p.harnessRequestId, true);
      this.emit(s, { kind: "tool_call", tool: p.toolName, auto_approved: true });
      return;
    }

    const hcpRequestId = `perm_${randomUUID().slice(0, 8)}`;
    const seq = this.emit(s, {
      kind: "permission_requested",
      request_id: hcpRequestId,
      summary: action.summary,
      risk: action.risk,
    });
    this.setState(s, "awaiting_input");

    const pending: Pending = {
      hcpRequestId,
      harnessRequestId: p.harnessRequestId,
      resolved: false,
      // A permission that blocks forever is a hung agent. Spec: permissions.md §2.
      timer: setTimeout(() => this.resolve(s, hcpRequestId, null, null, undefined), PERMISSION_TTL_MS),
    };
    s.pending.set(hcpRequestId, pending);

    // Same request id to every attached client; ids are per-connection scoped.
    const params = {
      session_id: s.id,
      seq,
      action,
      options: optionsFor(s),
      expires_at: new Date(Date.now() + PERMISSION_TTL_MS).toISOString(),
    };
    for (const c of this.clients)
      if (c.attached.has(s.id))
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: hcpRequestId,
                 method: "session/request_permission", params });
  }

  /** First well-formed answer wins; everything after gets -32007. */
  answerPermission(
    sessionId: string, requestId: string, optionId: string, text: string | undefined,
    client: Client,
  ): void {
    const s = this.get(sessionId);
    const p = s.pending.get(requestId);
    if (!p || p.resolved) throw rpc(ERR.permissionExpired, "already resolved or expired");
    const opt = optionsFor(s).find((o) => o.id === optionId);
    if (!opt) throw rpc(ERR.invalidParams, `unknown option: ${optionId}`);
    this.resolve(s, requestId, optionId, client, text);
  }

  private resolve(
    s: Session, requestId: string, optionId: string | null,
    client: Client | null, text?: string,
  ): void {
    const p = s.pending.get(requestId);
    if (!p || p.resolved) return;
    p.resolved = true;
    clearTimeout(p.timer);
    s.pending.delete(requestId);

    const opts = optionsFor(s);
    const opt = optionId ? opts.find((o) => o.id === optionId) : undefined;
    const allow = opt?.kind === "allow";
    if (opt?.scope === "session" && allow) {
      // Cheap approximation of scope: remember by tool for the session's lifetime.
      const ev = [...s.log].reverse().find((e) => e.update.kind === "permission_requested");
      if (ev) s.allowAlways.add(String((ev.update as any).tool ?? "Bash"));
    }

    this.broadcast(s, "session/permission_resolved", {
      session_id: s.id,
      request_id: requestId,
      seq: s.seq + 1,
      option_id: optionId,
      resolved_by: client ? { client_id: client.id, device_id: client.deviceId ?? null } : null,
    });

    // No option means the request expired; fall back to the most restrictive reject.
    s.harness.answerPermission(
      p.harnessRequestId, opt?.id ?? mostRestrictiveReject(opts) ?? "reject_once", text);

    if (!allow && text)
      this.emit(s, { kind: "user_message", text },
                client ? { client_id: client.id, device_id: client.deviceId } : undefined);

    this.setState(s, "working");
  }

  // --------------------------------------------------------------- clients

  addClient(c: Client): void { this.clients.add(c); }

  removeClient(c: Client): void { this.clients.delete(c); }

  // -------------------------------------------------------------- dispatch

  async handle(method: string, params: any, client: Client): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const versions: string[] = params?.protocol_versions ?? [];
        if (versions.length && !versions.includes(HCP_VERSION))
          throw rpc(ERR.versionUnsupported, `host speaks ${HCP_VERSION}`);
        client.deviceId = params?.device_id;
        client.formFactor = params?.client?.form_factor;
        const probe = this.makeHarness(process.cwd());
        return {
          protocol_version: HCP_VERSION,
          host: { name: "hcp-claude-code", version: "0.1.0", platform: process.platform },
          harness: { name: probe.name, version: probe.version, adapter: "hcp-claude-code/0.1.0" },
          capabilities: probe.capabilities(),
        };
      }

      case "host/sessions/list":
        return {
          sessions: [...this.sessions.values()].map((s) => ({
            session_id: s.id, name: s.name, cwd: s.cwd, state: s.state,
            seq: s.seq, oldest_seq: s.oldestSeq,
            pending_permissions: [...s.pending.keys()],
          })),
        };

      case "host/sessions/create": {
        const s = await this.createSession(String(params?.cwd ?? process.cwd()), params?.name);
        return { session_id: s.id, state: s.state, seq: s.seq };
      }

      case "session/attach": {
        const s = this.get(params?.session_id);
        const from = Number(params?.from_seq ?? s.seq);
        if (from > 0 && from < s.oldestSeq - 1)
          throw rpc(ERR.replayUnavailable, `oldest retained seq is ${s.oldestSeq}`);
        client.attached.add(s.id);

        const backlog = s.log.filter((e) => e.seq > from);
        queueMicrotask(() => {
          for (const e of backlog)
            client.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method: "session/update",
                          params: { ...stripAt(e), replayed: true } });
        });

        return {
          session_id: s.id, state: s.state, seq: s.seq, oldest_seq: s.oldestSeq,
          subscription_id: `sub_${randomUUID().slice(0, 6)}`,
          replaying: backlog.length > 0,
          pending_permissions: [...s.pending.keys()],
        };
      }

      case "session/detach":
        client.attached.delete(String(params?.session_id));
        return { ok: true };

      case "session/snapshot": {
        const s = this.get(params?.session_id);
        return {
          session_id: s.id, state: s.state, seq: s.seq, oldest_seq: s.oldestSeq,
          events: s.log.map(stripAt),
          pending_permissions: [...s.pending.keys()],
        };
      }

      case "session/prompt": {
        const s = this.get(params?.session_id);
        const text = String(params?.text ?? "");
        this.emit(s, { kind: "user_message", text },
                  { client_id: client.id, device_id: client.deviceId });
        this.setState(s, "working");
        s.harness.prompt(text);
        return { ok: true, seq: s.seq };
      }

      case "session/interrupt": {
        const s = this.get(params?.session_id);
        s.harness.interrupt();
        this.setState(s, "idle");
        return { ok: true };
      }

      case "session/steer": {
        const s = this.get(params?.session_id);
        if (!s.harness.steer)
          throw rpc(ERR.capabilityUnsupported,
                    `${s.harness.name} has no mid-turn steer; queue a prompt instead`);
        const text = String(params?.text ?? "");
        this.emit(s, { kind: "user_message", text, steer: true },
                  { client_id: client.id, device_id: client.deviceId });
        s.harness.steer(text);
        return { ok: true, seq: s.seq };
      }

      default:
        throw rpc(ERR.methodNotFound, `unknown method: ${method}`);
    }
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.harness.stop();
  }
}

function stripAt<T extends { at?: number }>(e: T): Omit<T, "at"> {
  const { at, ...rest } = e;
  return rest;
}

export function rpc(code: number, message: string): RpcError & { __rpc: true } {
  return { code, message, __rpc: true };
}
