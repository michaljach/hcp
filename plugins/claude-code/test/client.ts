/**
 * A minimal HCP client. Attaches to every session on the local HCP server, prints events,
 * and answers permission requests from stdin — the smallest thing that stands in for
 * a phone.
 *
 *   node test/client.ts
 */

import { connect } from "node:net";
import { createInterface } from "node:readline";
import { clientSocket } from "../src/paths.ts";
import { HCP_VERSION } from "../src/types.ts";

const sock = connect(clientSocket());
const send = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
let pending: string | null = null;
const attached = new Set<string>();

function attachAll(list: any[]) {
  if (!list.length && !attached.size) {
    console.log("Connected. No Claude Code session is registered yet — a session appears");
    console.log("here on its first hook event, so send a prompt in one and it will show up.");
    return;
  }
  for (const s of list) {
    if (attached.has(s.session_id)) continue;
    attached.add(s.session_id);
    console.log(`attaching to ${s.session_id} (${s.state})`);
    send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: `att_${s.session_id}`,
           method: "session/attach", params: { session_id: s.session_id, from_seq: 0 } });
  }
}

sock.on("error", (e: any) => {
  console.error(`Cannot reach the HCP server at ${clientSocket()}`);
  console.error(e.code === "ENOENT"
    ? "\nNothing is listening there. The server starts with the plugin's MCP server —\n" +
      "check `/mcp` inside Claude Code for a server named `hcp`. If it is connected but\n" +
      "this still fails, the running server predates this fix: disable and re-enable the\n" +
      "plugin so it picks up the new socket path."
    : `\n${e.message}`);
  process.exit(1);
});
sock.on("connect", () => {
  send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: "init", method: "initialize",
         params: { protocol_versions: [HCP_VERSION],
                   client: { name: "hcp-example-client", version: "0.1.0", form_factor: "phone" },
                   device_id: "dev_example" } });
  send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: "list", method: "host/sessions/list" });
});

createInterface({ input: sock }).on("line", (l) => {
  const m = JSON.parse(l);

  if (m.id === "list") { attachAll(m.result?.sessions ?? []); return; }

  // A session registered after we connected.
  if (m.method === "host/status") { attachAll(m.params?.sessions ?? []); return; }

  if (m.method === "session/update") {
    const u = m.params.update;
    const tag = m.params.replayed ? "replay" : "live  ";
    console.log(`  ${tag} #${m.params.seq} ${u.kind}${u.text ? ": " + u.text : ""}`);
    return;
  }

  if (m.method === "session/state") { console.log(`  state -> ${m.params.state}`); return; }

  if (m.method === "session/request_permission") {
    const a = m.params.action;
    pending = m.id;
    console.log(`\n  ${a.risk.toUpperCase()} RISK — ${a.summary}`);
    console.log(`  ${m.params.options.map((o: any) => o.id).join(" / ")}`);
    console.log(`  type an option id (then optional text) and press enter:`);
    return;
  }

  if (m.method === "session/permission_resolved") {
    console.log(`  resolved: ${m.params.option_id ?? "expired"} ` +
                `by ${m.params.resolved_by?.device_id ?? "nobody"}\n`);
    pending = null;
  }
});

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!pending) return;
  const [option_id, ...rest] = line.trim().split(/\s+/);
  send({ jsonrpc: "2.0", hcp: HCP_VERSION, id: pending,
         result: { option_id, text: rest.join(" ") || undefined } });
});
