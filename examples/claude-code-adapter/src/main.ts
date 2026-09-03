/**
 * Entry point. Speaks HCP over stdio (spec/v0.1/transport.md §2.1): one JSON-RPC
 * message per line, stdout is protocol, stderr is logs.
 *
 *   node src/main.ts --harness mock            # scripted, no CLI or tokens needed
 *   node src/main.ts --harness claude --cwd .  # drives the real Claude Code CLI
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { HcpHost } from "./host.ts";
import type { Client } from "./host.ts";
import { ClaudeCodeHarness, MockHarness } from "./harness.ts";
import type { Harness } from "./harness.ts";
import { HCP_VERSION, ERR } from "./types.ts";

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const harnessKind = arg("harness", "mock") as "mock" | "claude";
const cwd = arg("cwd", process.cwd()) as string;

const makeHarness = (dir: string): Harness =>
  harnessKind === "claude" ? new ClaudeCodeHarness(dir) : new MockHarness();

const host = new HcpHost(makeHarness);

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const log = (s: string) => process.stderr.write(`[hcp] ${s}\n`);

const client: Client = {
  id: `cl_${randomUUID().slice(0, 6)}`,
  send: out,
  attached: new Set(),
};
host.addClient(client);

let initialized = false;

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;

  let msg: any;
  try { msg = JSON.parse(line); }
  catch { return out(err(null, ERR.parse, "invalid JSON")); }

  // A response, not a request: the client is answering a host-originated request,
  // which in v0.1 means a permission.
  if (msg.id !== undefined && msg.method === undefined) {
    if (msg.error) return log(`client rejected ${msg.id}: ${msg.error.message}`);
    const sid = [...client.attached][0];
    try {
      host.answerPermission(sid, String(msg.id), String(msg.result?.option_id),
                            msg.result?.text, client);
    } catch (e: any) {
      log(`permission answer refused: ${e.message ?? e}`);
    }
    return;
  }

  if (typeof msg.method !== "string")
    return out(err(msg.id ?? null, ERR.invalidRequest, "missing method"));

  if (msg.id !== undefined && typeof msg.id !== "string")
    return out(err(null, ERR.invalidRequest, "request id must be a string"));

  if (!initialized && msg.method !== "initialize")
    return out(err(msg.id ?? null, ERR.notInitialized, "send initialize first"));

  try {
    const result = await host.handle(msg.method, msg.params ?? {}, client);
    if (msg.method === "initialize") initialized = true;
    if (msg.id !== undefined)
      out({ jsonrpc: "2.0", hcp: HCP_VERSION, id: msg.id, result });
  } catch (e: any) {
    const code = e?.__rpc ? e.code : ERR.internal;
    const message = e?.message ?? String(e);
    if (msg.id !== undefined) out(err(msg.id, code, message));
    else log(`notification failed: ${message}`);
  }
});

function err(id: string | null, code: number, message: string) {
  return { jsonrpc: "2.0", hcp: HCP_VERSION, id, error: { code, message } };
}

const shutdown = () => { host.shutdown(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Pre-create one session so an attaching client has somewhere to type immediately,
// mirroring `claude remote-control --create-session-in-dir`.
const s = await host.createSession(cwd, arg("name"));
log(`harness=${harnessKind} cwd=${cwd} session=${s.id} — ready on stdio`);
