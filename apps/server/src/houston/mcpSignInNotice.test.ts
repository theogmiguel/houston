import { describe, expect, it } from "vite-plus/test";

import { mcpSignInNoticeText, mcpSignInServerName } from "./mcpSignInNotice.ts";

describe("mcpSignInServerName", () => {
  it.each(["notion", "my-server_2", "claude.ai Gmail", "x".repeat(256)])("keeps %s", (name) => {
    expect(mcpSignInServerName(name)).toBe(name);
  });

  it.each([
    ["empty", ""],
    ["padded", " notion"],
    ["over-long", "x".repeat(257)],
    ["newline", "a\nb"],
    ["escape", "a\u001b[31mb"],
    ["bidi override", "a‮b"],
    ["line separator", "a b"],
  ])("refuses a %s name", (_label, name) => {
    expect(mcpSignInServerName(name)).toBeUndefined();
  });
});

describe("mcpSignInNoticeText", () => {
  it("names the server and the agent", () => {
    expect(mcpSignInNoticeText("notion", "Claude")).toEqual({
      title: "MCP server notion needs a sign-in",
      message: "The notion MCP server needs a sign-in before Claude can use it.",
    });
  });
});
