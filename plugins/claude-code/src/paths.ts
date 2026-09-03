import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

/**
 * Socket home. CLAUDE_PLUGIN_DATA survives plugin updates; fall back to a
 * per-uid temp dir. Mode 0700 — spec/v0.1/transport.md §2.2 makes filesystem
 * permissions the authentication for local IPC.
 */
export function socketDir(): string {
  const dir =
    process.env.CLAUDE_PLUGIN_OPTION_SOCKET_DIR ||
    process.env.CLAUDE_PLUGIN_DATA ||
    join(tmpdir(), `hcp-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const hookSocket = () => join(socketDir(), "hook.sock");
export const clientSocket = () => join(socketDir(), "hcp.sock");
export const daemonLog = () => join(socketDir(), "daemon.log");
