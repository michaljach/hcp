/**
 * The permission classifier.
 *
 * This is where an HCP adapter earns its keep. Claude Code hands over a raw tool
 * invocation — {tool_name: "Bash", input: {command: "npm run migrate:dev"}} — which
 * assumes a terminal is rendering it. HCP requires that a client be able to draw a
 * correct, actionable prompt from `summary` + `risk` + `options` alone, because that
 * is what fits on a lock screen.
 *
 * Everything here is a heuristic. It is deliberately conservative: when a rule is
 * unsure it grades UP, because the cost of over-warning is a needless tap and the
 * cost of under-warning is an unreviewed `git push --force`.
 */

import type { PermissionAction, RiskLevel } from "./types.ts";

interface Rule {
  test: RegExp;
  risk: RiskLevel;
  reversible?: boolean;
  summary: (m: RegExpMatchArray, raw: string) => string;
}

const trunc = (s: string, n = 96) =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

/** Ordered: first match wins, so the most specific patterns come first. */
const EXEC_RULES: Rule[] = [
  { test: /\brm\s+(-\w*[rf]\w*\s+)+(?<path>\S+)/,
    risk: "high", reversible: false,
    summary: (m) => `Recursively delete ${m.groups?.path ?? "files"}` },

  { test: /\bgit\s+push\b.*--force|--force.*\bgit\s+push\b|\bgit\s+push\s+-f\b/,
    risk: "high", reversible: false,
    summary: () => "Force-push, overwriting remote history" },

  { test: /\b(migrat\w*|db:push|prisma\s+db|flyway|liquibase|alembic)\b/,
    risk: "high", reversible: false,
    summary: (_m, raw) => `Run database migrations: ${trunc(raw)}` },

  { test: /\bnpm\s+publish\b|\bcargo\s+publish\b|\bgem\s+push\b|\btwine\s+upload\b/,
    risk: "high", reversible: false,
    summary: () => "Publish a package to a public registry" },

  { test: /\b(kubectl|terraform|helm|aws|gcloud|az)\b.*\b(apply|destroy|delete|deploy)\b/,
    risk: "high", reversible: false,
    summary: (_m, raw) => `Change deployed infrastructure: ${trunc(raw)}` },

  { test: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b|\bwget\b[^|]*\|\s*(ba)?sh\b/,
    risk: "high", reversible: false,
    summary: () => "Download a script from the network and execute it" },

  { test: /^\s*sudo\b/,
    risk: "high",
    summary: (_m, raw) => `Run as root: ${trunc(raw)}` },

  { test: /\b(DROP|TRUNCATE|DELETE)\s+(TABLE|FROM|DATABASE)\b/i,
    risk: "high", reversible: false,
    summary: (_m, raw) => `Destructive SQL: ${trunc(raw)}` },

  { test: /\bgit\s+(reset\s+--hard|clean\s+-\w*[fd])/,
    risk: "high", reversible: false,
    summary: () => "Discard uncommitted local changes" },

  { test: /\bgit\s+push\b/,
    risk: "medium",
    summary: (_m, raw) => `Push to remote: ${trunc(raw)}` },

  { test: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip\s+install\b|\bcargo\s+add\b/,
    risk: "medium",
    summary: (_m, raw) => `Install dependencies: ${trunc(raw)}` },

  { test: /\bnpm\s+run\s+(?<script>[\w:.-]+)/,
    risk: "medium",
    summary: (m) => `Run npm script "${m.groups?.script}"` },

  { test: /\bgit\s+(commit|add|checkout|switch|branch|merge|rebase)\b/,
    risk: "medium",
    summary: (_m, raw) => `Git operation: ${trunc(raw)}` },

  { test: /^\s*(ls|cat|head|tail|grep|rg|find|pwd|echo|wc|which|file|stat|tree)\b/,
    risk: "low", reversible: true,
    summary: (_m, raw) => `Read the filesystem: ${trunc(raw)}` },

  { test: /\b(test|jest|vitest|pytest|cargo\s+test|go\s+test)\b/,
    risk: "low",
    summary: (_m, raw) => `Run tests: ${trunc(raw)}` },

  { test: /\bgit\s+(status|diff|log|show|branch\s*$)/,
    risk: "low", reversible: true,
    summary: (_m, raw) => `Inspect the repository: ${trunc(raw)}` },
];

function classifyExec(input: Record<string, unknown>): PermissionAction {
  const argv = Array.isArray(input.command)
    ? (input.command as string[])
    : String(input.command ?? "").length
      ? [String(input.command)]
      : [];
  const raw = argv.length === 1 ? argv[0] : argv.join(" ");

  for (const rule of EXEC_RULES) {
    const m = raw.match(rule.test);
    if (m) {
      return {
        kind: "exec",
        summary: rule.summary(m, raw),
        risk: rule.risk,
        reversible: rule.reversible ?? false,
        detail: {
          command: argv,
          cwd: input.cwd ?? process.cwd(),
          sandbox: input.sandbox ?? "workspace-write",
          explanation: input.description,
        },
      };
    }
  }

  // Unmatched commands grade medium, never low. An unrecognized command is not
  // evidence of safety.
  return {
    kind: "exec",
    summary: `Run: ${trunc(raw) || "a shell command"}`,
    risk: "medium",
    reversible: false,
    detail: { command: argv, cwd: input.cwd ?? process.cwd() },
  };
}

const SENSITIVE_PATH =
  /(^|\/)(\.env|\.git\/config|id_rsa|id_ed25519|\.npmrc|\.aws|\.ssh|credentials|secrets?)(\/|$)/i;
const LOCKFILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/;

function classifyWrite(
  tool: string,
  input: Record<string, unknown>,
  workspace: string,
): PermissionAction {
  const path = String(input.file_path ?? input.path ?? "unknown");
  const outside = !path.startsWith(workspace);
  const created = tool === "Write" && !input.old_string;

  let risk: RiskLevel = "low";
  if (LOCKFILE.test(path)) risk = "medium";
  if (outside) risk = "medium";
  if (SENSITIVE_PATH.test(path)) risk = "high";

  const rel = outside ? path : path.slice(workspace.length).replace(/^\//, "");
  const verb = created ? "Create" : "Edit";
  const where = outside ? `${path} (outside the workspace)` : rel;

  const before = String(input.old_string ?? "");
  const after = String(input.new_string ?? input.content ?? "");

  return {
    kind: "write",
    summary: `${verb} ${where}`,
    risk,
    reversible: !created,
    detail: {
      path,
      created,
      outside_workspace: outside,
      bytes_added: after.length,
      bytes_removed: before.length,
      diff: input.diff ?? null,
    },
  };
}

function classifyNetwork(tool: string, input: Record<string, unknown>): PermissionAction {
  const url = String(input.url ?? input.query ?? "");
  let host = url;
  try { host = new URL(url).host; } catch { /* not a URL; keep the raw string */ }
  return {
    kind: "network",
    summary: tool === "WebSearch" ? `Search the web for "${trunc(url, 60)}"` : `Fetch ${host}`,
    risk: "medium",
    reversible: true,
    detail: { url, method: "GET", direction: "outbound", tool },
  };
}

/**
 * Map one Claude Code `can_use_tool` control request onto an HCP permission action.
 */
export function classify(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
): PermissionAction {
  if (toolName === "Bash" || toolName === "BashOutput") return classifyExec(input);
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit")
    return classifyWrite(toolName, input, workspace);
  if (toolName === "WebFetch" || toolName === "WebSearch")
    return classifyNetwork(toolName, input);

  if (toolName.startsWith("mcp__")) {
    const [, server, tool] = toolName.split("__");
    return {
      kind: "tool",
      summary: `Call ${tool ?? toolName} on the ${server ?? "MCP"} server`,
      risk: "medium",
      detail: { server, tool, arguments: input, mcp: true },
    };
  }

  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    return {
      kind: "tool",
      summary: `Read ${String(input.file_path ?? input.pattern ?? "project files")}`,
      risk: "low",
      reversible: true,
      detail: { tool: toolName, arguments: input },
    };
  }

  return {
    kind: "tool",
    summary: `Use the ${toolName} tool`,
    risk: "medium",
    detail: { tool: toolName, arguments: input },
  };
}
