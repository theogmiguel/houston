import {
  type AuthMcpClientAccess,
  type ManagedPolicySummary,
  managedRuntimeModeDenial,
  mcpClientScopes,
} from "@houston-app/contracts";
import { isLoopbackHost } from "@houston-app/shared/preview";

/** A command-line agent that connects to Houston's MCP server over HTTP with OAuth. */
const TRAILING_SLASHES = /\/+$/;

export interface McpClientApp {
  readonly id: string;
  readonly name: string;
  /** Commands to run where the agent runs, in order. */
  readonly commands: (mcpUrl: string) => readonly string[];
  readonly note?: string;
}

export const MCP_CLIENT_APPS: readonly McpClientApp[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    commands: (url) => [
      `claude mcp add --transport http houston ${url}`,
      "claude mcp login houston",
    ],
    note: "On a machine without a browser, add --no-browser to the login and paste the final URL back when asked.",
  },
  {
    id: "codex",
    name: "Codex",
    commands: (url) => [`codex mcp add houston --url ${url}`, "codex mcp login houston"],
    note: "codex mcp login --no-browser prints the sign-in URL instead of opening it.",
  },
];

/** The "Something else…" choice: the URL and general steps only. */
export const OTHER_MCP_CLIENT_STEPS = [
  "Add a remote MCP server with OAuth in the app, using the URL above.",
  "Apps that need their own client ID cannot connect.",
] as const;

/** The environment's MCP endpoint: its address with `/mcp` after any path prefix. */
export function environmentMcpUrl(httpBaseUrl: string): string {
  let base: URL;
  try {
    base = new URL(httpBaseUrl);
  } catch {
    throw new Error(`Expected the environment's http(s) address, got "${httpBaseUrl}".`);
  }
  base.pathname = `${base.pathname.replace(TRAILING_SLASHES, "")}/mcp`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** Why an agent may fail to sign in over `mcpUrl`, or null when nothing stands in the way. */
export function mcpUrlNote(mcpUrl: string): string | null {
  const { protocol, hostname } = new URL(mcpUrl);
  return protocol === "http:" && !isLoopbackHost(hostname)
    ? "This address is plain http. Agents sign in only over https or localhost, so use an https address for an agent on another machine."
    : null;
}

/**
 * Why `access` cannot be offered, or undefined when it can: the code is minted with this
 * session, which can grant only the scopes it holds, and a managed policy may cap the mode.
 */
export function mcpAccessDenial(
  access: AuthMcpClientAccess,
  session: { readonly has: (scope: string) => boolean },
  policy: ManagedPolicySummary | undefined,
): string | undefined {
  if (!mcpClientScopes(access).every((scope) => session.has(scope))) {
    return `Your session here cannot approve the "${access.replaceAll("-", " ")}" level.`;
  }
  return access === "read-only" ? undefined : managedRuntimeModeDenial(policy, access);
}
