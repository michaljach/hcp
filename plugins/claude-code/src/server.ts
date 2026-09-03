/**
 * The HCP server, hosted as a plugin MCP server.
 *
 * Why MCP: Claude Code starts a plugin's MCP server when the plugin is enabled and
 * stops it when the session ends. That is the whole reason this file exists in this
 * shape — the previous design spawned a detached daemon and had to babysit it with an
 * idle sweep, because nothing else owned its lifetime. Here Claude Code owns it.
 *
 * Three surfaces on one process:
 *
 *   stdio  — MCP, spoken to Claude Code. Exposes one tool, `hcp_status`.
 *   :7517  — HTTP, spoken to by this plugin's hooks. `type: "http"` hooks can return
 *            a permissionDecision, which `type: "mcp_tool"` hooks cannot; that is why
 *            the permission channel is HTTP and not an MCP tool.
 *   unix   — HCP v0.1 for clients (phone, browser, another harness).
 *
 * Every session's hooks POST to the same fixed port, so whichever process owns it
 * serves every session on the machine. Losing the bind is not an error: it means
 * another instance is already hosting.
 */

import { createServer as createHttp } from "node:http";
import { createServer as createSocket, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { classify } from "./classify.ts";
import { HCP_VERSION, ERR } from "./types.ts";
import type { PermissionOption, SessionState, SessionEvent } from "./types.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clientSocket, HOOK_PORT } from "./paths.ts";

/** Read from the manifest rather than hardcoded, which had already drifted once. */
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch { return "0.0.0"; }
})();

const MAX_EVENTS = 10_000;
/** Answers before the hook's own 120s ceiling in hooks.json, so we decide, not the clock. */
const PERMISSION_TTL_MS = 110_000;

const RISK_ORDER = { low: 0, medium: 1, high: 2 } as const;
const escalateFrom =
  (process.env.CLAUDE_PLUGIN_OPTION_ESCALATE_FROM ?? "medium") as keyof typeof RISK_ORDER;

const OPTIONS: PermissionOption[] = [
  { id: "allow_once", label: "Allow", kind: "allow", scope: "once" },
  { id: "reject_once", label: "Deny", kind: "reject", scope: "once" },
  { id: "reject_feedback", label: "Deny and explain", kind: "reject", scope: "once",
    accepts_text: true },
];

interface Client { id: string; deviceId?: string; send(m: unknown): void; attached: Set<string>; }
interface Pending { settle(d: { allow: boolean; reason?: string } | null): void;
                    timer: NodeJS.Timeout; done: boolean; }
interface Session { id: string; cwd: string; name: string; state: SessionState;
                    seq: number; oldestSeq: number; log: SessionEvent[];
                    pending: Map<string, Pending>; }

const sessions = new Map<string, Session>();
const clients = new Set<Client>();

function session(id: string, cwd = process.cwd()): Session {
  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd, name: cwd.split("/").pop() ?? "session", state: "idle",
          seq: 0, oldestSeq: 1, log: [], pending: new Map() };
    sessions.set(id, s);
    // Clients attach to a session list they fetched once. Without this, a client
    // that connected before any session existed would sit silent forever.
    announce();
  }
  return s;
}

/** `host/status` — spec/v0.1 method index. Goes to every client, attached or not. */
function announce() {
  const params = { sessions: [...sessions.values()].map(summarize) };
  for (const c of clients)
    c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method: "host/status", params });
}

const summarize = (s: Session) => ({
  session_id: s.id, name: s.name, cwd: s.cwd, state: s.state,
  seq: s.seq, oldest_seq: s.oldestSeq, pending_permissions: [...s.pending.keys()],
});

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

const attachedTo = (sid: string) => [...clients].some((c) => c.attached.has(sid));

// ----------------------------------------------------------------- hook side

/** Returns the JSON body a `type: "http"` hook expects. `{}` means no decision. */
async function onHook(m: any): Promise<unknown> {
  if (!m?.hook_event_name || !m?.session_id) return {};
  const s = session(m.session_id, m.cwd);

  switch (m.hook_event_name) {
    case "SessionStart": setState(s, "idle"); return {};
    case "UserPromptSubmit":
      emit(s, { kind: "user_message", text: m.prompt ?? "" });
      setState(s, "working");
      return {};
    case "PostToolUse":
      emit(s, { kind: "tool_result", tool: m.tool_name, output: m.tool_response ?? null });
      return {};
    case "Stop": setState(s, "idle"); return {};
    case "SessionEnd": setState(s, "ended"); sessions.delete(s.id); announce(); return {};
    case "PreToolUse": return await onPreToolUse(s, m);
    default: return {};
  }
}

async function onPreToolUse(s: Session, m: any): Promise<unknown> {
  const action = classify(m.tool_name ?? "unknown", m.tool_input ?? {}, s.cwd);
  emit(s, { kind: "tool_call", tool: m.tool_name, summary: action.summary, risk: action.risk });

  // Stay out of the way: nobody watching, or below the escalation floor. Returning {}
  // leaves Claude Code's own permission flow running exactly as if this were absent.
  if (!attachedTo(s.id)) return {};
  if (RISK_ORDER[action.risk] < RISK_ORDER[escalateFrom]) return {};

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

  // Expiry hands back to the local prompt rather than denying: a client that fell
  // asleep must not silently block the agent.
  if (!answer) {
    broadcast(s, "session/permission_resolved",
      { session_id: s.id, request_id: requestId, seq: s.seq, option_id: null, resolved_by: null });
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: answer.allow ? "allow" : "deny",
      permissionDecisionReason: answer.allow
        ? `Approved from a connected HCP client${answer.reason ? `: ${answer.reason}` : ""}`
        : answer.reason || "Denied from a connected HCP client",
    },
  };
}

// --------------------------------------------------------------- client side

async function onClient(method: string, params: any, c: Client): Promise<unknown> {
  const fail = (code: number, message: string) => { throw { __rpc: true, code, message }; };
  switch (method) {
    case "initialize": {
      const vs: string[] = params?.protocol_versions ?? [];
      if (vs.length && !vs.includes(HCP_VERSION)) fail(ERR.versionUnsupported, `host speaks ${HCP_VERSION}`);
      c.deviceId = params?.device_id;
      return {
        protocol_version: HCP_VERSION,
        host: { name: "hcp-plugin", version: VERSION, platform: process.platform },
        harness: { name: "claude-code", version: "unknown", adapter: `hcp-plugin/${VERSION}` },
        capabilities: {
          steer: false, interrupt: false, replay: true, snapshot: true, lease: false,
          fork: false, rollback: false, diff: false, terminal: false, push: false,
          permission_kinds: ["exec", "write", "tool", "network"],
          permission_scopes: ["once"],
          fs: { read: false, write: false, watch: false },
        },
      };
    }
    case "host/sessions/list":
      return { sessions: [...sessions.values()].map(summarize) };
    case "session/attach": {
      const s = sessions.get(String(params?.session_id));
      if (!s) fail(ERR.sessionNotFound, "no such session");
      const from = Number(params?.from_seq ?? s!.seq);
      if (from > 0 && from < s!.oldestSeq - 1) fail(ERR.replayUnavailable, `oldest is ${s!.oldestSeq}`);
      c.attached.add(s!.id);
      const backlog = s!.log.filter((e) => e.seq > from);
      queueMicrotask(() => { for (const e of backlog)
        c.send({ jsonrpc: "2.0", hcp: HCP_VERSION, method: "session/update",
                 params: { ...e, replayed: true } }); });
      return { session_id: s!.id, state: s!.state, seq: s!.seq, oldest_seq: s!.oldestSeq,
               subscription_id: `sub_${randomUUID().slice(0, 6)}`,
               replaying: backlog.length > 0, pending_permissions: [...s!.pending.keys()] };
    }
    case "session/detach": c.attached.delete(String(params?.session_id)); return { ok: true };
    case "session/snapshot": {
      const s = sessions.get(String(params?.session_id));
      if (!s) fail(ERR.sessionNotFound, "no such session");
      return { session_id: s!.id, state: s!.state, seq: s!.seq, oldest_seq: s!.oldestSeq,
               events: s!.log, pending_permissions: [...s!.pending.keys()] };
    }
    case "session/prompt":
    case "session/steer":
      return fail(ERR.capabilityUnsupported,
                  "the plugin observes and approves; it cannot originate turns");
    default:
      return fail(ERR.methodNotFound, `unknown method: ${method}`);
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

// -------------------------------------------------------------------- listeners

const http = createHttp((req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    let reply: unknown = {};
    try { reply = await onHook(JSON.parse(body)); } catch { reply = {}; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
// Loopback only. spec/v0.1/transport.md forbids a non-loopback bind without auth.
http.on("error", () => {});
const bind = () => http.listen(HOOK_PORT, "127.0.0.1");
http.on("error", (e: any) => {
  // EADDRINUSE means another instance is hosting. Retry so that if it exits, we take over.
  if (e?.code === "EADDRINUSE") setTimeout(bind, 30_000).unref();
});
bind();

if (existsSync(clientSocket())) { try { unlinkSync(clientSocket()); } catch {} }
createSocket((sock: Socket) => {
  const c: Client = { id: `cl_${randomUUID().slice(0, 6)}`,
                      send: (m) => sock.write(JSON.stringify(m) + "\n"), attached: new Set() };
  clients.add(c);
  sock.on("close", () => clients.delete(c));
  sock.on("error", () => clients.delete(c));
  createInterface({ input: sock }).on("line", async (l) => {
    if (!l.trim()) return;
    let m: any;
    try { m = JSON.parse(l); } catch { return; }
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
}).listen(clientSocket());

// ------------------------------------------------------------------ MCP stdio

const mcpOut = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

const TOOLS = [{
  name: "hcp_status",
  description:
    "Report which HCP clients are attached and which sessions are waiting on a remote " +
    "approval. Use when the user asks whether anything is watching or why a tool call is " +
    "waiting.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

function status(): string {
  const lines = [
    `HCP ${HCP_VERSION} — ${clients.size} client(s) attached, ${sessions.size} session(s)`,
    `escalate_from=${escalateFrom}  hooks=http://127.0.0.1:${HOOK_PORT}  clients=${clientSocket()}`,
  ];
  for (const s of sessions.values()) {
    lines.push(`  ${s.id}  ${s.state.padEnd(15)} seq ${s.seq}  ${s.name}`);
    for (const p of s.pending.keys()) lines.push(`      awaiting a decision: ${p}`);
  }
  if (!clients.size)
    lines.push("No client attached, so tool calls fall through to the normal local prompt.");
  return lines.join("\n");
}

createInterface({ input: process.stdin }).on("line", (l) => {
  if (!l.trim()) return;
  let m: any;
  try { m = JSON.parse(l); } catch { return; }
  const reply = (result: unknown) => mcpOut({ jsonrpc: "2.0", id: m.id, result });

  switch (m.method) {
    case "initialize":
      // Echo the client's protocol version rather than pinning one.
      return reply({
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hcp", version: VERSION },
      });
    case "notifications/initialized": return;
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call":
      if (m.params?.name !== "hcp_status")
        return reply({ content: [{ type: "text", text: `unknown tool: ${m.params?.name}` }],
                       isError: true });
      return reply({ content: [{ type: "text", text: status() }] });
    default:
      if (m.id !== undefined)
        mcpOut({ jsonrpc: "2.0", id: m.id,
                 error: { code: -32601, message: `unknown method: ${m.method}` } });
  }
});
