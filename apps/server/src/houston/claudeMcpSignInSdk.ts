// @effect-diagnostics nodeBuiltinImport:off - the version is read once from the installed SDK's manifest, before any Effect runtime exists.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The Claude Agent SDK's MCP sign-in calls exist on the object `query()` returns but are missing
 * from its type declarations. This is the one place that reaches for them, so an SDK that drops
 * or renames one fails with a named error instead of a `TypeError` deep in a request.
 */

let installedVersion: string | undefined;
/** The installed SDK's version, read from its manifest because the SDK does not export it. */
export function claudeAgentSdkVersion(): string {
  if (installedVersion !== undefined) return installedVersion;
  try {
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const manifest: unknown = JSON.parse(
      readFileSync(join(dirname(entry), "package.json"), "utf8"),
    );
    const version =
      typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : null;
    installedVersion = typeof version === "string" ? version : "(unknown version)";
  } catch {
    installedVersion = "(unknown version)";
  }
  return installedVersion;
}

export class ClaudeSdkMethodMissingError extends Error {
  override readonly name = "ClaudeSdkMethodMissingError";
  readonly method: string;
  constructor(method: string) {
    super(
      `Claude Agent SDK ${claudeAgentSdkVersion()} has no query.${method}(), which MCP sign-in needs. Update Houston or use an SDK version that provides it.`,
    );
    this.method = method;
  }
}

export interface ClaudeMcpSignInSdk {
  /** The reply to `mcp_authenticate`; its shape is decoded by the caller. */
  readonly authenticate: (server: string) => Promise<unknown>;
  /** Hands the pasted address to the CLI, which checks its state. */
  readonly submitCallbackUrl: (server: string, callbackUrl: string) => Promise<unknown>;
}

const requireMethod = (query: object, method: "mcpAuthenticate" | "mcpSubmitOAuthCallbackUrl") => {
  const candidate: unknown = Reflect.get(query, method);
  if (typeof candidate !== "function") throw new ClaudeSdkMethodMissingError(method);
  return (...args: ReadonlyArray<unknown>): Promise<unknown> =>
    Promise.resolve(Reflect.apply(candidate, query, args));
};

/** Throws `ClaudeSdkMethodMissingError` when the query object lacks either call. */
export function claudeMcpSignInSdk(query: object): ClaudeMcpSignInSdk {
  const authenticate = requireMethod(query, "mcpAuthenticate");
  const submit = requireMethod(query, "mcpSubmitOAuthCallbackUrl");
  return {
    // No redirect URI: the CLI listens on its own loopback port and reports the page to open.
    authenticate: (server) => authenticate(server),
    submitCallbackUrl: (server, callbackUrl) => submit(server, callbackUrl),
  };
}
