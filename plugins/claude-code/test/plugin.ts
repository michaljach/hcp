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

send({ jsonrpc: "2.0", hcp: "0.1", id: "p", method: "session/prompt",
       params: { session_id: SESSION, text: "hi" } });
check("session/prompt is -32005 (a hook cannot inject a turn)",
      (await waitFor((m) => m.id === "p")).error?.code === -32005);

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

// 6 — seq, and the status tool reflecting live state
const seqs = inbox.filter((m) => m.method === "session/update").map((m) => m.params.seq);
check("seq is gapless", seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1), seqs.join(","));

const st = await mcp(3, "tools/call", { name: "hcp_status", arguments: {} });
const text = st.result?.content?.[0]?.text ?? "";
check("hcp_status reports the attached client", /1 client\(s\) attached/.test(text), text.split("\n")[0]);

// 7 — shared modules must not drift from the adapter's copies
for (const f of ["classify.ts", "types.ts"]) {
  const a = readFileSync(join(ROOT, "..", "..", "examples", "claude-code-adapter", "src", f), "utf8");
  check(`src/${f} is identical to the adapter's copy`,
        a === readFileSync(join(ROOT, "src", f), "utf8"));
}

sock.destroy(); srv.kill();
rmSync(SOCKET_DIR, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
