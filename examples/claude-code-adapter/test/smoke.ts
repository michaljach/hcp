/**
 * End-to-end smoke test against the mock harness.
 *
 * Drives the adapter over its stdio transport exactly as a remote client would, and
 * asserts the four properties the spec is actually claiming: a phone-renderable
 * permission envelope, first-answer-wins resolution with attribution, a gapless seq,
 * and replay-on-reattach.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const proc = spawn(process.execPath, [join(here, "..", "src", "main.ts"),
                                      "--harness", "mock"],
                   { stdio: ["pipe", "pipe", "pipe"] });

const inbox: any[] = [];
const waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];

createInterface({ input: proc.stdout }).on("line", (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  inbox.push(m);
  const i = waiters.findIndex((w) => w.match(m));
  if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
});
proc.stderr.on("data", () => {});

const send = (o: unknown) => proc.stdin.write(JSON.stringify(o) + "\n");
const rpc = (id: string, method: string, params: unknown = {}) => {
  send({ jsonrpc: "2.0", hcp: "0.1", id, method, params });
  return waitFor((m) => m.id === id && (m.result || m.error));
};
const waitFor = (match: (m: any) => boolean, ms = 4000): Promise<any> => {
  const hit = inbox.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
    waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
};

let failures = 0;
const check = (name: string, cond: unknown, detail = "") => {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name}${detail ? "  <-- " + detail : ""}`); failures++; }
};

console.log("\nHCP adapter smoke test (mock harness)\n");

// 1 — negotiation
const init = await rpc("c1", "initialize", {
  protocol_versions: ["0.1"],
  client: { name: "smoke", version: "0.1.0", form_factor: "phone" },
  device_id: "dev_test",
});
check("initialize returns protocol_version 0.1", init.result?.protocol_version === "0.1");
check("advertises steer:false (Claude Code cannot steer mid-turn)",
      init.result?.capabilities?.steer === false);
check("names the harness and adapter",
      typeof init.result?.harness?.adapter === "string");

const bad = await rpc("c1b", "initialize", { protocol_versions: ["9.9"],
                                             client: { name: "x", version: "1" } });
check("rejects an unsupported protocol version with -32008",
      bad.error?.code === -32008, JSON.stringify(bad.error));

// 2 — sessions and attach
const list = await rpc("c2", "host/sessions/list");
const sid = list.result?.sessions?.[0]?.session_id;
check("a session was pre-created", typeof sid === "string");

const att = await rpc("c3", "session/attach", { session_id: sid, from_seq: 0 });
check("attach reports seq and oldest_seq",
      typeof att.result?.seq === "number" && typeof att.result?.oldest_seq === "number");
check("attach reports pending_permissions", Array.isArray(att.result?.pending_permissions));

const missing = await rpc("c3b", "session/attach", { session_id: "s_nope" });
check("unknown session is -32003", missing.error?.code === -32003);

// 3 — the permission envelope
await rpc("c4", "session/prompt", { session_id: sid, text: "apply the migrations" });
const perm = await waitFor((m) => m.method === "session/request_permission");
const a = perm.params?.action;
check("permission arrives as a host-originated request", typeof perm.id === "string");
check("carries a one-line summary", typeof a?.summary === "string" && a.summary.length <= 120,
      a?.summary);
check("classified the migration command as high risk", a?.risk === "high", a?.risk);
check("marked irreversible", a?.reversible === false);
check("summary is renderable without detail",
      a?.summary?.includes("migration") || a?.summary?.includes("migrate"), a?.summary);
check("offers a deny-with-feedback option",
      perm.params?.options?.some((o: any) => o.accepts_text === true));
check("sets an expiry", typeof perm.params?.expires_at === "string");

// 4 — resolution with attribution
send({ jsonrpc: "2.0", hcp: "0.1", id: perm.id,
       result: { option_id: "reject_feedback", text: "Use staging, not dev" } });
const resolved = await waitFor((m) => m.method === "session/permission_resolved");
check("resolution is broadcast", resolved.params?.request_id === perm.id);
check("attributes the answering device",
      resolved.params?.resolved_by?.device_id === "dev_test",
      JSON.stringify(resolved.params?.resolved_by));
check("the denial reason became a user message",
      await waitFor((m) => m.method === "session/update" &&
                           m.params?.update?.kind === "user_message" &&
                           m.params?.update?.text === "Use staging, not dev").then(() => true));

// 5 — the seq contract
const updates = inbox.filter((m) => m.method === "session/update");
const seqs = updates.map((m) => m.params.seq);
check("every event carries a seq", seqs.every((n) => typeof n === "number"));
check("seq is strictly increasing and gapless",
      seqs.every((n, i) => i === 0 || n === seqs[i - 1] + 1),
      seqs.join(","));

// 6 — replay on reattach, the property a phone on a flaky tunnel depends on
await rpc("c5", "session/detach", { session_id: sid });
inbox.length = 0;
const re = await rpc("c6", "session/attach", { session_id: sid, from_seq: 2 });
check("reattach reports replaying:true", re.result?.replaying === true);
const replayed = await waitFor((m) => m.method === "session/update" && m.params?.replayed);
check("replayed events are flagged", replayed.params.replayed === true);
check("replay resumes at from_seq + 1", replayed.params.seq === 3, String(replayed.params.seq));

const stale = await rpc("c7", "session/steer", { session_id: sid, text: "x" });
check("unadvertised steer returns -32005", stale.error?.code === -32005);

proc.kill();
console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
