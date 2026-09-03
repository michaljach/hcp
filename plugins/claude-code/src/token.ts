import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { socketDir } from "./paths.ts";

/**
 * A capability token, the same shape Codex uses for its non-loopback app-server
 * listeners. spec/v0.1/pairing-and-relay.md asks for Ed25519 device keypairs, which
 * is stronger; a browser on a phone cannot hold one without a real pairing flow, so
 * this is the honest interim and the gap is documented.
 *
 * Persisted in the 0700 socket directory so a restart does not invalidate the page
 * already open on someone's phone.
 */
export function capabilityToken(): string {
  const path = join(socketDir(), "token");
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t.length >= 32) return t;
  } catch { /* first run */ }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(path, t + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

/** Constant-time compare, so a token cannot be recovered by timing the 401s. */
export function tokenMatches(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The LAN address a phone can actually reach, or null when only loopback is up. */
export function lanAddress(): string | null {
  for (const iface of Object.values(networkInterfaces())) {
    for (const n of iface ?? []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return null;
}
