import { HOUSTON_MCP_SERVER_NAME_MAX_LENGTH } from "@houston-app/contracts/houston/mcpSignIn";

// Printable text only: a server picks its own name, and the name reaches the notice and the UI.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The server name when it is safe to put in a notice and an RPC: non-blank, no longer than the
 * contract bound, no control or format characters. Anything else is not announced, because a
 * trimmed or rewritten name would sign in a different server than the one that asked.
 */
export function mcpSignInServerName(name: string): string | undefined {
  if (name.trim() !== name || name.length === 0) return undefined;
  if (name.length > HOUSTON_MCP_SERVER_NAME_MAX_LENGTH) return undefined;
  if (UNPRINTABLE.test(name)) return undefined;
  return name;
}

/** Notice wording shared by every provider that offers a sign-in. */
export function mcpSignInNoticeText(server: string, agent: string) {
  return {
    title: `MCP server ${server} needs a sign-in`,
    message: `The ${server} MCP server needs a sign-in before ${agent} can use it.`,
  };
}
