/**
 * `node src/cli.ts <status|stop|watch>` — what the /hcp slash command runs.
 */

import { connect } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { clientSocket, hookSocket, socketDir } from "./paths.ts";
import { HCP_VERSION } from "./types.ts";

const cmd = process.argv[2] ?? "status";

if (cmd === "stop") {
  for (const p of [hookSocket(), clientSocket()])
    if (existsSync(p)) { try { unlinkSync(p); } catch {} }
  console.log("HCP daemon sockets removed. It exits on its next idle sweep.");
  process.exit(0);
}

if (!existsSync(clientSocket())) {
  console.log("HCP daemon is not running. It starts on the next SessionStart hook.");
  console.log(`Socket directory: ${socketDir()}`);
  process.exit(0);
}

const sock = connect(clientSocket());
const send = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
const seen: any[] = [];

sock.on("error", (e) => { console.log(`Cannot reach the daemon: ${e.message}`); process.exit(0); });
sock.on("connect", () => {
  send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: "1", method: "initialize",
         params: { protocol_versions: [HCP_VERSION],
                   client: { name: "hcp-cli", version: "0.1.0", form_factor: "desktop" },
                   device_id: "dev_local_cli" } });
  send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: "2", method: "host/sessions/list" });
});

createInterface({ input: sock }).on("line", (l) => {
  const m = JSON.parse(l);
  seen.push(m);
  if (m.id !== "2") return;

  const list = m.result?.sessions ?? [];
  console.log(`\nHCP daemon up — ${clientSocket()}`);
  console.log(`Protocol ${HCP_VERSION}, ${list.length} session(s)\n`);
  if (!list.length) console.log("  (no sessions registered yet)");
  for (const s of list) {
    const flag = s.state === "awaiting_input" ? "  <-- needs a decision" : "";
    console.log(`  ${s.session_id}  ${String(s.state).padEnd(15)} seq ${s.seq}` +
                `  ${s.name}${flag}`);
    for (const p of s.pending_permissions ?? []) console.log(`      pending: ${p}`);
  }
  console.log("\nAttach a client:  node examples/claude-code-plugin/test/client.ts\n");
  sock.destroy();
  process.exit(0);
});
