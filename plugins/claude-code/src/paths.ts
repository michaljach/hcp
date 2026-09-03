import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

/**
 * The hook port is fixed because `hooks.json` is static config and cannot read a
 * value chosen at runtime. Every session's hooks POST here, so whichever server owns
 * the port serves every session on the machine. Loopback only.
 */
export const HOOK_PORT = Number(process.env.HCP_HOOK_PORT ?? 7517);

/** Mode 0700 — spec/v0.1/transport.md §2.2 makes file permissions the authentication. */
export function socketDir(): string {
  const dir =
    process.env.CLAUDE_PLUGIN_OPTION_SOCKET_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(tmpdir(), `hcp-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const clientSocket = () => join(socketDir(), "hcp.sock");
