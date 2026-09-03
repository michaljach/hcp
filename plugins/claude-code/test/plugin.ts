/**
 * End-to-end test of the plugin.
 *
 * Exercises all three of the server's surfaces the way their real callers do: the MCP
 * handshake over stdio as Claude Code speaks it, HTTP POSTs as `type: "http"` hooks
 * send them, and the HCP unix socket as a client uses it.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOCKET_DIR = mkdtempSync(join(tmpdir(), "hcp-test-"));
const PORT = 7600 + Math.floor(Math.random() * 300);
const SESSION = "cc_session_test";
const HOOK_URL = `http://127.0.0.1:${PORT}/hook`;

let failures = 0;
const check = (name: string, cond: unknown, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? "  <-- " + detail : ""}`); failures++; }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The server is launched exactly as .mcp.json launches it: a stdio subprocess.
const srv = spawn(process.execPath, [join(ROOT, "src", "server.ts")], {
  env: { ...process.env, HCP_SOCKET_DIR: SOCKET_DIR, HCP_HOOK_PORT: String(PORT) },
  stdio: ["pipe", "pipe", "pipe"],
});
const mcpInbox: any[] = [];
createInterface({ input: srv.stdout }).on("line", (l) => {
  if (l.trim()) mcpInbox.push(JSON.parse(l));
});
srv.stderr.on("data", () => {});
const mcp = (id: number, method: string, params: unknown = {}) => {
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return waitUntil(() => mcpInbox.find((m) => m.id === id));
};
async function waitUntil<T>(f: () => T | undefined, ms = 4000): Promise<T> {
  for (let i = 0; i < ms / 25; i++) { const v = f(); if (v) return v; await sleep(25); }
  throw new Error("timeout");
}
const postHook = (payload: Record<string, unknown>) =>
  fetch(HOOK_URL, { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ session_id: SESSION, cwd: ROOT, ...payload }) })
    .then((r) => r.json() as Promise<any>);

console.log("\nHCP plugin end-to-end (MCP-hosted)\n");

// 1 — MCP, as Claude Code speaks it
const init = await mcp(1, "initialize",
  { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
check("MCP initialize echoes the client's protocol version",
      init.result?.protocolVersion === "2025-06-18");
check("MCP serverInfo names the plugin", init.result?.serverInfo?.name === "hcp");
srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const tools = await mcp(2, "tools/list");
check("exposes hcp_status to the model",
      tools.result?.tools?.[0]?.name === "hcp_status");

// 2 — the HTTP hook surface
await waitUntil(() => existsSync(join(SOCKET_DIR, "hcp.sock")));
await postHook({ hook_event_name: "SessionStart" });
check("the unix socket is listening", existsSync(join(SOCKET_DIR, "hcp.sock")));

const passthrough = await postHook({
  hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "npm run migrate:dev" }, tool_use_id: "t1" });
check("no attached client -> no decision, local flow runs",
      Object.keys(passthrough).length === 0, JSON.stringify(passthrough));

// 3 — an HCP client over the unix socket
const sock = connect(join(SOCKET_DIR, "hcp.sock"));
const inbox: any[] = [];
const waiters: Array<{ m: (x: any) => boolean; r: (x: any) => void }> = [];
const send = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
const waitFor = (m: (x: any) => boolean, ms = 5000): Promise<any> => {
  const hit = inbox.find(m);
  if (hit) return Promise.resolve(hit);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    waiters.push({ m, r: (x) => { clearTimeout(t); res(x); } });
  });
};
createInterface({ input: sock }).on("line", (l) => {
  const m = JSON.parse(l); inbox.push(m);
  const i = waiters.findIndex((w) => w.m(m));
  if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
await new Promise((r) => sock.on("connect", r));

send({ jsonrpc: "2.0", hcp: "0.1", id: "i", method: "initialize",
       params: { protocol_versions: ["0.1"], client: { name: "t", version: "1", form_factor: "phone" },
                 device_id: "dev_test_phone" } });
check("HCP initialize succeeds", (await waitFor((m) => m.id === "i")).result?.protocol_version === "0.1");

send({ jsonrpc: "2.0", hcp: "0.1", id: "l", method: "host/sessions/list" });
check("the Claude Code session is registered",
      (await waitFor((m) => m.id === "l")).result?.sessions?.[0]?.session_id === SESSION);

send({ jsonrpc: "2.0", hcp: "0.1", id: "a", method: "session/attach",
       params: { session_id: SESSION, from_seq: 0 } });
await waitFor((m) => m.id === "a");

// 4 — the escalation floor
const low = await postHook({ hook_event_name: "PreToolUse", tool_name: "Bash",
                             tool_input: { command: "git status" }, tool_use_id: "t2" });
check("low risk stays below the escalation floor", Object.keys(low).length === 0);

// 5 — high risk escalates and the phone's answer becomes the HTTP response
const pending = postHook({ hook_event_name: "PreToolUse", tool_name: "Bash",
                           tool_input: { command: "npm run migrate:dev" }, tool_use_id: "t3" });
const perm = await waitFor((m) => m.method === "session/request_permission");
check("high risk reaches the client", perm.params?.action?.risk === "high");
check("summary is phone-sized", perm.params.action.summary.length <= 120);
check("session goes to awaiting_input",
      await waitFor((m) => m.method === "session/state" &&
                           m.params.state === "awaiting_input").then(() => true));

send({ jsonrpc: "2.0", hcp: "0.1", id: perm.id,
       result: { option_id: "reject_feedback", text: "Use staging, not dev" } });

const body = await pending;
check("the hook response carries a PreToolUse decision",
      body.hookSpecificOutput?.hookEventName === "PreToolUse");
check("the phone's denial becomes permissionDecision:deny",
      body.hookSpecificOutput?.permissionDecision === "deny",
      JSON.stringify(body));
check("the reason reaches Claude",
      body.hookSpecificOutput?.permissionDecisionReason === "Use staging, not dev");
check("resolution attributes the device",
      (await waitFor((m) => m.method === "session/permission_resolved"))
        .params?.resolved_by?.device_id === "dev_test_phone");

// 6 — a session that registers AFTER a client connected must announce itself.
// Without this the client sits silent forever, which is exactly what happened in
// the field: it lists sessions once at connect and never learns about later ones.
await postHook({ session_id: "cc_session_later", hook_event_name: "SessionStart" });
const announced = await waitFor((m) => m.method === "host/status" &&
  (m.params?.sessions ?? []).some((x: any) => x.session_id === "cc_session_later"));
check("a later session is announced over host/status",
      !!announced, JSON.stringify(announced?.params));

// 7 — the queued prompt path: client -> Claude, delivered at turn end
send({ jsonrpc: "2.0", hcp: "0.1", id: "q1", method: "session/prompt",
       params: { session_id: SESSION, text: "use the staging database" } });
const q1 = await waitFor((m) => m.id === "q1");
check("session/prompt is accepted and queued", q1.result?.queued === 1, JSON.stringify(q1.error));
check("the reply says when it will land", q1.result?.delivery === "on_turn_end");
check("clients see the queued prompt",
      await waitFor((m) => m.method === "session/update" &&
                           m.params?.update?.queued === true).then(() => true));

send({ jsonrpc: "2.0", hcp: "0.1", id: "q2", method: "session/prompt",
       params: { session_id: SESSION, text: "then run the tests" } });
check("a second prompt queues behind the first",
      (await waitFor((m) => m.id === "q2")).result?.queued === 2);

const stop1 = await postHook({ hook_event_name: "Stop", stop_hook_active: false });
check("Stop blocks and carries the first prompt",
      stop1.hookSpecificOutput?.decision === "block" &&
      stop1.hookSpecificOutput?.continueWithInstructions === "use the staging database",
      JSON.stringify(stop1));
check("the block names the remaining queue depth",
      /1 more/.test(stop1.hookSpecificOutput?.reason ?? ""), stop1.hookSpecificOutput?.reason);

const stop2 = await postHook({ hook_event_name: "Stop", stop_hook_active: true });
check("the next Stop delivers the second prompt in order",
      stop2.hookSpecificOutput?.continueWithInstructions === "then run the tests");

const stop3 = await postHook({ hook_event_name: "Stop", stop_hook_active: true });
check("an empty queue lets the session stop — the drain terminates",
      Object.keys(stop3).length === 0, JSON.stringify(stop3));

const bad = await new Promise<any>((r) => {
  send({ jsonrpc: "2.0", hcp: "0.1", id: "q3", method: "session/prompt",
         params: { session_id: SESSION, text: "   " } });
  waitFor((m) => m.id === "q3").then(r);
});
check("an empty prompt is rejected", bad.error?.code === -32602);

send({ jsonrpc: "2.0", hcp: "0.1", id: "st", method: "session/steer",
       params: { session_id: SESSION, text: "x" } });
check("session/steer is still -32005 — it is genuinely mid-turn",
      (await waitFor((m) => m.id === "st")).error?.code === -32005);

// 8 — seq, and the status tool reflecting live state
const seqs = inbox.filter((m) => m.method === "session/update").map((m) => m.params.seq);
check("seq is gapless", seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1), seqs.join(","));

const st = await mcp(3, "tools/call", { name: "hcp_status", arguments: {} });
const text = st.result?.content?.[0]?.text ?? "";
check("hcp_status reports the attached client", /1 client\(s\) attached/.test(text), text.split("\n")[0]);

// 9 — the web surface a phone actually uses
console.log();
const TOKEN = readFileSync(join(SOCKET_DIR, "token"), "utf8").trim();
const base = `http://127.0.0.1:${PORT}`;

check("the page is refused without a token", (await fetch(`${base}/`)).status === 401);
check("a wrong token is refused", (await fetch(`${base}/?t=nope`)).status === 401);
const page = await fetch(`${base}/?t=${TOKEN}`);
check("the page is served with a token", page.status === 200);
const html = await page.text();
check("the page is self-contained (no CDN, no external fonts)",
      !/src="http|href="http/.test(html), "found an external reference");

// SSE + POST, exactly as the browser does it
const es = await fetch(`${base}/events?t=${TOKEN}`);
check("SSE stream opens", es.headers.get("content-type")?.startsWith("text/event-stream"));
const reader = es.body!.getReader();
const dec = new TextDecoder();
let buf = "";
async function nextEvent(): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const nl = buf.indexOf("\n\n");
    if (nl >= 0) {
      const chunk = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const line = chunk.split("\n").find((x) => x.startsWith("data: "));
      if (line) return JSON.parse(line.slice(6));
      continue;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value, { stream: true });
  }
  throw new Error("no event");
}
const hello = await nextEvent();
check("the stream opens with a client id", hello.method === "hello" && !!hello.params.client_id);
const WC = hello.params.client_id;

const post = (body: unknown) =>
  fetch(`${base}/rpc?t=${TOKEN}&c=${WC}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const winit = await (await post({ jsonrpc: "2.0", hcp: "0.1", id: "w1",
  method: "initialize", params: { protocol_versions: ["0.1"],
    client: { name: "web", version: "1", form_factor: "phone" }, device_id: "web_test" } })).json();
check("the web client can initialize over /rpc", winit.result?.protocol_version === "0.1");

const wlist = await (await post({ jsonrpc: "2.0", hcp: "0.1", id: "w2",
  method: "host/sessions/list" })).json();
check("it sees the same sessions as a socket client",
      (wlist.result?.sessions ?? []).some((x: any) => x.session_id === SESSION));

check("an unknown client id is rejected",
      (await fetch(`${base}/rpc?t=${TOKEN}&c=cl_nope`, { method: "POST",
        headers: { "content-type": "application/json" }, body: "{}" })).status === 409);

check("/hook needs no token but must be a POST",
      (await fetch(`${base}/hook?t=`)).status === 403);

reader.cancel().catch(() => {});

// 10 — shared modules must not drift from the adapter's copies
for (const f of ["classify.ts", "types.ts"]) {
  const a = readFileSync(join(ROOT, "..", "..", "examples", "claude-code-adapter", "src", f), "utf8");
  check(`src/${f} is identical to the adapter's copy`,
        a === readFileSync(join(ROOT, "src", f), "utf8"));
}

sock.destroy(); srv.kill();
rmSync(SOCKET_DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
