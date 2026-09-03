/**
 * The HCP daemon.
 *
 * Unlike examples/claude-code-adapter, nothing here spawns Claude Code. The daemon
 * sits beside a real session and is fed by the plugin's hooks, which means it sees
 * the actual permission flow rather than a driven copy of it.
 *
 * Two unix sockets, deliberately separate because they carry different trust:
 *   hook.sock   — internal, spoken by this plugin's hooks only
 *   hcp.sock    — HCP v0.1 for clients (phone, browser, another harness)
 */

import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync, appendFileSync } from "node:fs";
import { classify } from "./classify.ts";
import { HCP_VERSION, ERR } from "./types.ts";
import type { PermissionOption, SessionState, SessionEvent } from "./types.ts";
import { hookSocket, clientSocket, daemonLog } from "./paths.ts";

const MAX_EVENTS = 10_000;
/** Answer before the hook's own 120s timeout fires, so the daemon decides, not the clock. */
const PERMISSION_TTL_MS = 110_000;
const IDLE_EXIT_MS = 60 * 60 * 1000;

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;
const escalateFrom =
  (process.env.CLAUDE_PLUGIN_OPTION_ESCALATE_FROM ?? "medium") as keyof typeof RISK_ORDER;

const OPTIONS: PermissionOption[] = [
  { id: "allow_once", label: "Allow", kind: "allow", scope: "once" },
  { id: "reject_once", label: "Deny", kind: "reject", scope: "once" },
  { id: "reject_feedback", label: "Deny and explain", kind: "reject", scope: "once",
    accepts_text: true },
];

const log = (s: string) => {
  try { appendFileSync(daemonLog(), `[${new Date().toISOString()}] ${s}\n`); } catch {}
};

interface Client { id: string; deviceId?: string; send(m: unknown): void; attached: Set<string>; }

interface Pending {
  settle(decision: { allow: boolean; reason?: string } | null): void;
  timer: NodeJS.Timeout;
  done: boolean;
}

interface Session {
  id: string; cwd: string; name: string; state: SessionState;
  seq: number; oldestSeq: number;
  log: SessionEvent[];
  pending: Map<string, Pending>;
}

const sessions = new Map<string, Session>();
const clients = new Set<Client>();
let lastActivity = Date.now();

function session(id: string, cwd = process.cwd()): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd, name: cwd.split("/").pop() ?? "session", state: "idle",
          seq: 0, oldestSeq: 1, log: [], pending: new Map() };
    sessions.set(id, s);
    log(`session registered ${id} cwd=${cwd}`);
  }
  return s;
}

function emit(s: Session, update: Record<string, unknown>): number {
  const ev: SessionEvent = { session_id: s.id, seq: ++s.seq, update: update as any };
  s.log.push(ev);
  while (s.log.length > MAX_EVENTS) { const d = s.log.shift(); if (d) s.oldestSeq = d.seq + 1; }
  broadcast(s, "session/update", ev);
  return ev.seq;
}

function setState(s: Session, state: SessionState) {
  if (s.state === state) return;
  s.state = state;
  broadcast(s, "session/state", { session_id: s.id, state, seq: s.seq });
}

function broadcast(s: Session, method: string, params: unknown) {
  for (const c of clients)
    if (c.attached.has(s.id)) c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method, params });
}

function attachedTo(sid: string): boolean {
  for (const c of clients) if (c.attached.has(sid)) return true;
  return false;
}

// ------------------------------------------------------------------ hook side

interface HookMsg {
  hook_event_name: string; session_id: string; cwd?: string;
  tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string;
  prompt?: string; tool_response?: unknown;
}

async function onHook(m: HookMsg): Promise<unknown> {
  lastActivity = Date.now();
  const s = session(m.session_id, m.cwd);

  switch (m.hook_event_name) {
    case "SessionStart":
      setState(s, "idle");
      return { ok: true };

    case "UserPromptSubmit":
      emit(s, { kind: "user_message", text: m.prompt ?? "" });
      setState(s, "working");
      return { ok: true };

    case "PostToolUse":
      emit(s, { kind: "tool_result", tool: m.tool_name, output: m.tool_response ?? null });
      return { ok: true };

    case "Stop":
      setState(s, "idle");
      return { ok: true };

    case "SessionEnd":
      setState(s, "ended");
      sessions.delete(s.id);
      return { ok: true };

    case "PreToolUse":
      return await onPreToolUse(s, m);

    default:
      return { ok: true };
  }
}

async function onPreToolUse(s: Session, m: HookMsg): Promise<unknown> {
  const action = classify(m.tool_name ?? "unknown", m.tool_input ?? {}, s.cwd);
  emit(s, { kind: "tool_call", tool: m.tool_name, summary: action.summary, risk: action.risk });

  // Two reasons to stay out of the way, and both matter: nobody is watching
  // remotely, or this is below the escalation floor. In either case return no
  // decision so Claude Code's own permission flow runs exactly as it would
  // without the plugin installed.
  if (!attachedTo(s.id)) return { decision: null, reason: "no attached clients" };
  if (RISK_ORDER[action.risk] < RISK_ORDER[escalateFrom])
    return { decision: null, reason: `risk ${action.risk} below ${escalateFrom}` };

  const requestId = `perm_${randomUUID().slice(0, 8)}`;
  const seq = emit(s, { kind: "permission_requested", request_id: requestId,
                        summary: action.summary, risk: action.risk });
  setState(s, "awaiting_input");

  const answer = await new Promise<{ allow: boolean; reason?: string } | null>((resolve) => {
    const p: Pending = {
      done: false,
      settle: (d) => { if (!p.done) { p.done = true; clearTimeout(p.timer); resolve(d); } },
      timer: setTimeout(() => p.settle(null), PERMISSION_TTL_MS),
    };
    s.pending.set(requestId, p);

    for (const c of clients)
      if (c.attached.has(s.id))
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: requestId,
                 method: "session/request_permission",
                 params: { session_id: s.id, seq, action, options: OPTIONS,
                           expires_at: new Date(Date.now() + PERMISSION_TTL_MS).toISOString() } });
  });

  s.pending.delete(requestId);
  setState(s, "working");

  // Expired with no answer: hand back to the local permission flow rather than
  // denying. A remote client that fell asleep must not silently block the agent.
  if (!answer) {
    broadcast(s, "session/permission_resolved",
      { session_id: s.id, request_id: requestId, seq: s.seq, option_id: null, resolved_by: null });
    return { decision: null, reason: "expired" };
  }
  return { decision: answer.allow ? "allow" : "deny", reason: answer.reason };
}

// ---------------------------------------------------------------- client side

async function onClient(method: string, params: any, c: Client): Promise<unknown> {
  lastActivity = Date.now();
  switch (method) {
    case "initialize": {
      const vs: string[] = params?.protocol_versions ?? [];
      if (vs.length && !vs.includes(HCP_VERSION))
        throw { __rpc: true, code: ERR.versionUnsupported, message: `host speaks ${HCP_VERSION}` };
      c.deviceId = params?.device_id;
      return {
        protocol_version: HCP_VERSION,
        host: { name: "hcp-plugin", version: "0.1.0", platform: process.platform },
        harness: { name: "claude-code", version: process.env.CLAUDE_CODE_VERSION ?? "unknown",
                   adapter: "hcp-plugin/0.1.0" },
        capabilities: {
          steer: false, interrupt: false, replay: true, snapshot: true,
          lease: false, fork: false, rollback: false, diff: false, terminal: false, push: false,
          permission_kinds: ["exec", "write", "tool", "network"],
          permission_scopes: ["once"],
          fs: { read: false, write: false, watch: false },
        },
      };
    }

    case "host/sessions/list":
      return { sessions: [...sessions.values()].map((s) => ({
        session_id: s.id, name: s.name, cwd: s.cwd, state: s.state,
        seq: s.seq, oldest_seq: s.oldestSeq, pending_permissions: [...s.pending.keys()] })) };

    case "session/attach": {
      const s = sessions.get(String(params?.session_id));
      if (!s) throw { __rpc: true, code: ERR.sessionNotFound, message: "no such session" };
      const from = Number(params?.from_seq ?? s.seq);
      if (from > 0 && from < s.oldestSeq - 1)
        throw { __rpc: true, code: ERR.replayUnavailable, message: `oldest is ${s.oldestSeq}` };
      c.attached.add(s.id);
      const backlog = s.log.filter((e) => e.seq > from);
      queueMicrotask(() => { for (const e of backlog)
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method: "session/update",
                 params: { ...e, replayed: true } }); });
      return { session_id: s.id, state: s.state, seq: s.seq, oldest_seq: s.oldestSeq,
               subscription_id: `sub_${randomUUID().slice(0, 6)}`,
               replaying: backlog.length > 0, pending_permissions: [...s.pending.keys()] };
    }

    case "session/detach":
      c.attached.delete(String(params?.session_id));
      return { ok: true };

    case "session/snapshot": {
      const s = sessions.get(String(params?.session_id));
      if (!s) throw { __rpc: true, code: ERR.sessionNotFound, message: "no such session" };
      return { session_id: s.id, state: s.state, seq: s.seq, oldest_seq: s.oldestSeq,
               events: s.log, pending_permissions: [...s.pending.keys()] };
    }

    case "session/prompt":
    case "session/steer":
      // A hook cannot inject a turn into a running CLI session. This is the one
      // real cost of living inside the session instead of driving it.
      throw { __rpc: true, code: ERR.capabilityUnsupported,
              message: "the plugin observes and approves; it cannot originate turns" };

    default:
      throw { __rpc: true, code: ERR.methodNotFound, message: `unknown method: ${method}` };
  }
}

function answerPermission(requestId: string, optionId: string, text: string | undefined, c: Client) {
  for (const s of sessions.values()) {
    const p = s.pending.get(requestId);
    if (!p) continue;
    const opt = OPTIONS.find((o) => o.id === optionId);
    if (!opt) return;
    broadcast(s, "session/permission_resolved", {
      session_id: s.id, request_id: requestId, seq: s.seq + 1, option_id: optionId,
      resolved_by: { client_id: c.id, device_id: c.deviceId ?? null },
    });
    if (opt.kind === "reject" && text) emit(s, { kind: "user_message", text });
    p.settle({ allow: opt.kind === "allow", reason: text });
    return;
  }
}

// -------------------------------------------------------------------- servers

function ndjson(sock: Socket, onLine: (m: any) => void) {
  createInterface({ input: sock }).on("line", (l) => {
    if (!l.trim()) return;
    try { onLine(JSON.parse(l)); } catch { /* ignore malformed frames */ }
  });
}

function listen(path: string, onConn: (s: Socket) => void) {
  if (existsSync(path)) { try { unlinkSync(path); } catch {} }
  const srv = createServer(onConn);
  srv.listen(path);
  return srv;
}

listen(hookSocket(), (sock) => {
  ndjson(sock, async (m) => {
    let reply: unknown = { decision: null };
    try { reply = await onHook(m); } catch (e: any) { log(`hook error: ${e?.message ?? e}`); }
    sock.write(JSON.stringify(reply) + "\n");
  });
});

listen(clientSocket(), (sock) => {
  const c: Client = {
    id: `cl_${randomUUID().slice(0, 6)}`,
    send: (m) => sock.write(JSON.stringify(m) + "\n"),
    attached: new Set(),
  };
  clients.add(c);
  sock.on("close", () => clients.delete(c));
  ndjson(sock, async (m) => {
    if (m.id !== undefined && m.method === undefined) {
      if (m.result?.option_id) answerPermission(String(m.id), m.result.option_id, m.result.text, c);
      return;
    }
    try {
      const result = await onClient(m.method, m.params ?? {}, c);
      if (m.id !== undefined) c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: m.id, result });
    } catch (e: any) {
      if (m.id !== undefined)
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: m.id,
                 error: { code: e?.__rpc ? e.code : ERR.internal, message: e?.message ?? String(e) } });
    }
  });
});

setInterval(() => {
  if (clients.size === 0 && sessions.size === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) {
    log("idle with no sessions or clients — exiting");
    process.exit(0);
  }
}, 60_000).unref();

log(`daemon up — hooks=${hookSocket()} clients=${clientSocket()} escalate_from=${escalateFrom}`);
if (process.env.HCP_ANNOUNCE) process.stdout.write("HCP_DAEMON_READY\n");
