import { ProviderDriverKind } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderAdapterV2McpSignIn } from "../ProviderAdapter.ts";
import { requireMcpSignIn } from "./mcpSignIn.ts";

const driver = ProviderDriverKind.make("opencode");

describe("requireMcpSignIn", () => {
  it("returns the session's capability when it has one", async () => {
    const capability: ProviderAdapterV2McpSignIn = {
      start: () => Effect.succeed({ authorizationUrl: null }),
      complete: () => Effect.void,
    };
    const result = await Effect.runPromise(
      requireMcpSignIn({ mcpSignIn: capability }, { driver, server: "notion" }),
    );
    expect(result).toBe(capability);
  });

  it("refuses a session without it, naming the provider, the capability and the server", async () => {
    const exit = await Effect.runPromiseExit(requireMcpSignIn({}, { driver, server: "notion" }));
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
    expect(failure).toContain("HoustonMcpSignInError");
    expect(failure).toContain("unsupported-provider");
    expect(failure).toContain("opencode");
    expect(failure).toContain("MCP sign-in");
    expect(failure).toContain("notion");
  });
});
