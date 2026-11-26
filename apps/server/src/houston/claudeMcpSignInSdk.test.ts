import { describe, expect, it } from "vite-plus/test";

import {
  claudeAgentSdkVersion,
  ClaudeSdkMethodMissingError,
  claudeMcpSignInSdk,
} from "./claudeMcpSignInSdk.ts";

describe("claudeMcpSignInSdk", () => {
  it("forwards the two sign-in calls to the query object", async () => {
    const calls: Array<unknown> = [];
    const sdk = claudeMcpSignInSdk({
      mcpAuthenticate: async (...args: Array<unknown>) => {
        calls.push(["authenticate", ...args]);
        return { authUrl: "https://auth.example.com/a", requiresUserAction: true };
      },
      mcpSubmitOAuthCallbackUrl: async (...args: Array<unknown>) => {
        calls.push(["submit", ...args]);
      },
    });
    expect(await sdk.authenticate("notion")).toEqual({
      authUrl: "https://auth.example.com/a",
      requiresUserAction: true,
    });
    await sdk.submitCallbackUrl("notion", "http://127.0.0.1:1/cb?code=a&state=b");
    expect(calls).toEqual([
      ["authenticate", "notion"],
      ["submit", "notion", "http://127.0.0.1:1/cb?code=a&state=b"],
    ]);
  });

  it.each(["mcpAuthenticate", "mcpSubmitOAuthCallbackUrl"])(
    "names the SDK version and the missing method when %s is absent",
    (missing) => {
      const query: Record<string, unknown> = {
        mcpAuthenticate: async () => ({}),
        mcpSubmitOAuthCallbackUrl: async () => ({}),
      };
      delete query[missing];
      let caught: unknown;
      try {
        claudeMcpSignInSdk(query);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ClaudeSdkMethodMissingError);
      const message = (caught as Error).message;
      expect(message).toContain(claudeAgentSdkVersion());
      expect(message).toContain(missing);
    },
  );

  it("reads the installed SDK's version", () => {
    expect(claudeAgentSdkVersion()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
