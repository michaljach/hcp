/**
 * End-to-end test of the plugin, exercising the real hook entry point over the real
 * unix sockets. Nothing is stubbed except Claude Code itself, whose hook payloads are
 * synthesized to the documented shape.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SOCKET_DIR = mkdtempSync(join(tmpdir(), "hcp-test-"));
const ENV = { ...process.env, CLAUDE_PLUGIN_OPTION_SOCKET_DIR: SOCKET_DIR,
              CLAUDE_PLUGIN_ROOT: ROOT };
const SESSION = "cc_session_test";

let failures = 0;
const check = (name: string, cond: unknown, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? "  <-- " + detail : ""}`); failures++; }
};

/** Run hooks/hook.ts exactly as Claude Code would, and capture its stdout. */
function fireHook(payload: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(ROOT, "hooks", "hook.ts")],
                    { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", () => {});
    p.on("close", () => resolve(out.trim()));
    p.stdin.write(JSON.stringify({ session_id: SESSION, cwd: ROOT, ...payload }));
    p.stdin.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("\nHCP plugin end-to-end\n");

// 1 — SessionStart brings the daemon up
await fireHook({ hook_event_name: "SessionStart" });
for (let i = 0; i < 40 && !existsSync(join(SOCKET_DIR, "hcp.sock")); i++) await sleep(50);
check("SessionStart starts the daemon", existsSync(join(SOCKET_DIR, "hcp.sock")));

// 2 — with nobody attached, PreToolUse must be invisible
const passthrough = await fireHook({
  hook_event_name: "PreToolUse", tool_name: "Bash",
  tool_input: { command: "npm run migrate:dev" }, tool_use_id: "t1",
});
check("no attached client -> no decision, local flow runs", passthrough === "", passthrough);

// 3 — attach an HCP client
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
  const m = JSON.parse(l);
  inbox.push(m);
  const i = waiters.findIndex((w) => w.m(m));
  if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
await new Promise((r) => sock.on("connect", r));

send({ jsonrpc: "2.0", hcp: "0.1", id: "i", method: "initialize",
       params: { protocol_versions: ["0.1"], client: { name: "t", version: "1", form_factor: "phone" },
                 device_id: "dev_test_phone" } });
const init = await waitFor((m) => m.id === "i");
check("initialize succeeds", init.result?.protocol_version === "0.1");
check("advertises it cannot originate turns", init.result?.capabilities?.steer === false);

send({ jsonrpc: "2.0", hcp: "0.1", id: "p", method: "session/prompt",
       params: { session_id: SESSION, text: "hi" } });
const refused = await waitFor((m) => m.id === "p");
check("session/prompt is -32005 (a hook cannot inject a turn)",
      refused.error?.code === -32005, JSON.stringify(refused.error));

send({ jsonrpc: "2.0", hcp: "0.1", id: "l", method: "host/sessions/list" });
const list = await waitFor((m) => m.id === "l");
check("the Claude Code session is registered",
      list.result?.sessions?.[0]?.session_id === SESSION);

send({ jsonrpc: "2.0", hcp: "0.1", id: "a", method: "session/attach",
       params: { session_id: SESSION, from_seq: 0 } });
await waitFor((m) => m.id === "a");
check("attach succeeds", true);

// 4 — low risk must not escalate even with a client attached
const lowRisk = await fireHook({ hook_event_name: "PreToolUse", tool_name: "Bash",
                                 tool_input: { command: "git status" }, tool_use_id: "t2" });
check("low risk stays below the escalation floor", lowRisk === "", lowRisk);

// 5 — high risk escalates, and the phone's answer becomes the hook's decision
const pending = fireHook({ hook_event_name: "PreToolUse", tool_name: "Bash",
                           tool_input: { command: "npm run migrate:dev" }, tool_use_id: "t3" });
const perm = await waitFor((m) => m.method === "session/request_permission");
check("high risk reaches the client", perm.params?.action?.risk === "high");
check("summary is phone-sized", perm.params.action.summary.length <= 120);
check("session goes to awaiting_input",
      await waitFor((m) => m.method === "session/state" &&
                           m.params.state === "awaiting_input").then(() => true));

send({ jsonrpc: "2.0", hcp: "0.1", id: perm.id,
       result: { option_id: "reject_feedback", text: "Use staging, not dev" } });

const hookOut = JSON.parse(await pending);
check("hook emits a PreToolUse decision",
      hookOut.hookSpecificOutput?.hookEventName === "PreToolUse");
check("the phone's denial becomes permissionDecision:deny",
      hookOut.hookSpecificOutput?.permissionDecision === "deny",
      JSON.stringify(hookOut.hookSpecificOutput));
check("the reason reaches Claude",
      hookOut.hookSpecificOutput?.permissionDecisionReason === "Use staging, not dev",
      hookOut.hookSpecificOutput?.permissionDecisionReason);

const resolved = await waitFor((m) => m.method === "session/permission_resolved");
check("resolution attributes the device",
      resolved.params?.resolved_by?.device_id === "dev_test_phone");

// 6 — seq stays gapless across hook-driven events
const seqs = inbox.filter((m) => m.method === "session/update").map((m) => m.params.seq);
check("seq is gapless", seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1), seqs.join(","));

// 7 — the shared modules must not drift from the adapter's copies
for (const f of ["classify.ts", "types.ts"]) {
  const a = readFileSync(join(ROOT, "..", "..", "examples", "claude-code-adapter", "src", f), "utf8");
  const b = readFileSync(join(ROOT, "src", f), "utf8");
  check(`src/${f} is identical to the adapter's copy`, a === b);
}

sock.destroy();
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
