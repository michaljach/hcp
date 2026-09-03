/**
 * End-to-end smoke test for the Codex adapter.
 *
 * Beyond the usual HCP checks, this asserts the thing the spec actually claims:
 * host.ts, classify.ts, shared.ts and types.ts are byte-identical to the Claude Code
 * adapter's, so the only Codex-specific code in the process is one driver file.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const proc = spawn(process.execPath, [join(ROOT, "src", "main.ts"), "--harness", "mock"],
                   { stdio: ["pipe", "pipe", "pipe"] });

const inbox: any[] = [];
const waiters: Array<{ m: (x: any) => boolean; r: (x: any) => void }> = [];
createInterface({ input: proc.stdout }).on("line", (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  inbox.push(m);
  const i = waiters.findIndex((w) => w.m(m));
  if (i >= 0) waiters.splice(i, 1)[0].r(m);
});
proc.stderr.on("data", () => {});

const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");
const waitFor = (m: (x: any) => boolean, ms = 4000): Promise<any> => {
  const hit = inbox.find(m);
  if (hit) return Promise.resolve(hit);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    waiters.push({ m, r: (x) => { clearTimeout(t); res(x); } });
  });
};
const rpc = (id: string, method: string, params: unknown = {}) => {
  send({ jsonrpc: "2.0", hcp: "0.1", id, method, params });
  return waitFor((m) => m.id === id && (m.result || m.error));
};

let failures = 0;
const check = (name: string, cond: unknown, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? "  <-- " + detail : ""}`); failures++; }
};

console.log("\nHCP Codex adapter smoke test (mock harness)\n");

// 1 — negotiation, and the capability differences from Claude Code
const init = await rpc("c1", "initialize", {
  protocol_versions: ["0.1"],
  client: { name: "smoke", version: "0.1.0", form_factor: "phone" },
  device_id: "dev_test",
});
const caps = init.result?.capabilities;
check("initialize returns protocol_version 0.1", init.result?.protocol_version === "0.1");
check("names codex as the harness", init.result?.harness?.name === "codex");
check("advertises steer:true (turn/steer exists)", caps?.steer === true);
check("advertises fork and rollback", caps?.fork === true && caps?.rollback === true);
check("advertises terminal:true (command/exec exists)", caps?.terminal === true);
check("advertises elicit among permission kinds",
      caps?.permission_kinds?.includes("elicit"));

// 2 — attach
const list = await rpc("c2", "host/sessions/list");
const sid = list.result?.sessions?.[0]?.session_id;
await rpc("c3", "session/attach", { session_id: sid, from_seq: 0 });
check("attach succeeds", typeof sid === "string");

// 3 — the permission envelope, and Codex's richer option set
await rpc("c4", "session/prompt", { session_id: sid, text: "apply the migrations" });
const perm = await waitFor((m) => m.method === "session/request_permission");
const ids = (perm.params?.options ?? []).map((o: any) => o.id);
check("classified the migration as high risk", perm.params?.action?.risk === "high");
check("summary survives Codex's typed params",
      /migrat/i.test(perm.params?.action?.summary ?? ""), perm.params?.action?.summary);
check("offers reject_cancel (deny and stop the turn)", ids.includes("reject_cancel"));
check("does NOT offer reject_feedback — Codex's decline carries no message",
      !ids.includes("reject_feedback"), ids.join(","));

// 4 — HCP option maps onto the Codex decision enum
send({ jsonrpc: "2.0", hcp: "0.1", id: perm.id, result: { option_id: "reject_cancel" } });
const decided = await waitFor((m) => m.method === "session/update" &&
                                     String(m.params?.update?.text ?? "").startsWith("Codex decision:"));
check("reject_cancel maps to the Codex `cancel` decision",
      decided.params.update.text === "Codex decision: cancel", decided.params.update.text);
const resolved = await waitFor((m) => m.method === "session/permission_resolved");
check("resolution attributes the device",
      resolved.params?.resolved_by?.device_id === "dev_test");

// 5 — steer works here, unlike the Claude Code adapter
const steer = await rpc("c5", "session/steer", { session_id: sid, text: "use staging" });
check("session/steer succeeds where the Claude adapter returns -32005",
      steer.result?.ok === true, JSON.stringify(steer.error));

// 6 — the seq contract
const seqs = inbox.filter((m) => m.method === "session/update").map((m) => m.params.seq);
check("seq is strictly increasing and gapless",
      seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1), seqs.join(","));

// 7 — replay
await rpc("c6", "session/detach", { session_id: sid });
inbox.length = 0;
const re = await rpc("c7", "session/attach", { session_id: sid, from_seq: 1 });
check("reattach replays", re.result?.replaying === true);
const replayed = await waitFor((m) => m.method === "session/update" && m.params?.replayed);
check("replay resumes at from_seq + 1", replayed.params.seq === 2, String(replayed.params.seq));

// 8 — the harness-independence claim, made checkable
console.log();
for (const f of ["host.ts", "shared.ts", "classify.ts", "types.ts"]) {
  const a = readFileSync(join(ROOT, "..", "claude-code-adapter", "src", f), "utf8");
  const b = readFileSync(join(ROOT, "src", f), "utf8");
  check(`src/${f} is byte-identical to the Claude Code adapter's`, a === b);
}
const mine = readFileSync(join(ROOT, "src", "harness.ts"), "utf8");
const theirs = readFileSync(join(ROOT, "..", "claude-code-adapter", "src", "harness.ts"), "utf8");
check("src/harness.ts is the only source file that differs", mine !== theirs);

proc.kill();
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
