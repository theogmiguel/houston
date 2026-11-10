import { describe, expect, it } from "vite-plus/test";

import { MCP_CLIENT_APPS, environmentMcpUrl, mcpAccessDenial, mcpUrlNote } from "./mcpClients";

describe("environmentMcpUrl", () => {
  it("appends /mcp to the environment's address, keeping a path prefix", () => {
    expect(environmentMcpUrl("http://127.0.0.1:3773")).toBe("http://127.0.0.1:3773/mcp");
    expect(environmentMcpUrl("https://box.example.ts.net/")).toBe("https://box.example.ts.net/mcp");
    expect(environmentMcpUrl("https://example.test/houston/")).toBe(
      "https://example.test/houston/mcp",
    );
  });

  it("names the value it could not read", () => {
    expect(() => environmentMcpUrl("not a url")).toThrow(/not a url/);
  });
});

describe("mcpUrlNote", () => {
  it("is silent for https and loopback addresses", () => {
    expect(mcpUrlNote("https://box.example.ts.net/mcp")).toBeNull();
    expect(mcpUrlNote("http://localhost:3773/mcp")).toBeNull();
    expect(mcpUrlNote("http://127.0.0.1:3773/mcp")).toBeNull();
  });

  it("warns that an agent cannot sign in over plain http to another machine", () => {
    expect(mcpUrlNote("http://100.64.0.2:3773/mcp")).toMatch(/https/);
  });
});

describe("mcpAccessDenial", () => {
  const session = (...scopes: string[]) => ({ has: (scope: string) => scopes.includes(scope) });

  it("allows a level whose scopes the session holds", () => {
    expect(mcpAccessDenial("read-only", session("orchestration:read"), undefined)).toBeUndefined();
  });

  it("names the missing grant for a level the session cannot mint", () => {
    expect(
      mcpAccessDenial(
        "full-access",
        session("orchestration:read", "orchestration:operate"),
        undefined,
      ),
    ).toMatch(/full access/);
  });

  it("explains a policy ceiling", () => {
    const policy = {
      organization: "Acme",
      limits: { maxRuntimeMode: "approval-required" },
    } as never;
    const all = session(
      "orchestration:read",
      "orchestration:operate",
      "settings:write",
      "source-control:write",
    );
    expect(mcpAccessDenial("auto", all, policy)).toMatch(/Acme/);
    expect(mcpAccessDenial("approval-required", all, policy)).toBeUndefined();
  });
});

describe("MCP_CLIENT_APPS", () => {
  it("builds a command that registers the URL and a login step for each app", () => {
    for (const app of MCP_CLIENT_APPS) {
      const commands = app.commands("http://localhost:3773/mcp");
      expect(commands.length, app.id).toBeGreaterThan(0);
      expect(commands.join("\n"), app.id).toContain("http://localhost:3773/mcp");
    }
  });
});
