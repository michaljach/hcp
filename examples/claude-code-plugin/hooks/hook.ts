/**
 * The one hook entry point. hooks.json points every event here; this dispatches on
 * `hook_event_name`.
 *
 * Prime directive: never break the session. Every failure path — daemon down, socket
 * gone, bad JSON, old Node — exits 0 with no decision, which hands the tool call back
 * to Claude Code's normal permission flow. A remote-control plugin that can wedge a
 * local session is worse than no plugin.
 */

import { connect } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hookSocket } from "../src/paths.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECT_TIMEOUT_MS = 2_000;
/** Under the hook's own 120s ceiling in hooks.json, which is over the daemon's 110s. */
const REPLY_TIMEOUT_MS = 118_000;

const pass = () => process.exit(0);

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    setTimeout(() => resolve(buf), 3_000);
  });
}

function startDaemon(): void {
  const child = spawn(process.execPath, [join(ROOT, "src", "daemon.ts")],
                      { detached: true, stdio: "ignore" });
  child.unref();
}

function ask(payload: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    const sock = connect(hookSocket());
    const done = (v: any) => { try { sock.destroy(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);

    sock.on("error", () => { clearTimeout(t); done(null); });
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    createInterface({ input: sock }).on("line", (l) => {
      clearTimeout(t);
      try { done(JSON.parse(l)); } catch { done(null); }
    });
  });
}

const main = async () => {
  const raw = await readStdin();
  let ev: any;
  try { ev = JSON.parse(raw); } catch { return pass(); }
  if (!ev?.hook_event_name) return pass();

  if (ev.hook_event_name === "SessionStart" && !existsSync(hookSocket())) {
    startDaemon();
    // Give the daemon a moment to bind before the first event needs it.
    await new Promise((r) => setTimeout(r, 300));
  }

  const isPermission = ev.hook_event_name === "PreToolUse";
  const reply = await ask(ev, isPermission ? REPLY_TIMEOUT_MS : CONNECT_TIMEOUT_MS);

  if (!isPermission || !reply?.decision) return pass();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: reply.decision,
      permissionDecisionReason:
        reply.decision === "allow"
          ? `Approved from a connected HCP client${reply.reason ? `: ${reply.reason}` : ""}`
          : reply.reason || "Denied from a connected HCP client",
    },
  }) + "\n");
  pass();
};

main().catch(pass);
