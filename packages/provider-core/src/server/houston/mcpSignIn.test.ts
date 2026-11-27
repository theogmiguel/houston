import { ProviderDriverKind } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import type { ProviderAdapterV2McpSignIn } from "../ProviderAdapter.ts";
import { requireMcpSignIn } from "./mcpSignIn.ts";

const driver = ProviderDriverKind.make("opencode");

describe("requireMcpSignIn", () => {
  it.effect("returns the session's capability when it has one", () =>
    Effect.gen(function* () {
      const capability: ProviderAdapterV2McpSignIn = {
        start: () => Effect.succeed({ authorizationUrl: null }),
        complete: () => Effect.void,
      };
      const result = yield* requireMcpSignIn(
        { mcpSignIn: capability },
        { driver, server: "notion" },
      );
      expect(result).toBe(capability);
    }),
  );

  it.effect(
    "refuses a session without it, naming the provider, the capability and the server",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(requireMcpSignIn({}, { driver, server: "notion" }));
        expect(Exit.isFailure(exit)).toBe(true);
        const failure = Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";
        expect(failure).toContain("HoustonMcpSignInError");
        expect(failure).toContain("unsupported-provider");
        expect(failure).toContain("opencode");
        expect(failure).toContain("MCP sign-in");
        expect(failure).toContain("notion");
      }),
  );
});
