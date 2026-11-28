import { describe, expect, it } from "vite-plus/test";

import {
  availableTerminalCommandEntries,
  parseTerminalCommand,
  resolveTerminalCommand,
  TERMINAL_COMMAND_ENTRIES,
  type TerminalActionId,
} from "./composerTerminalCommands";

const ALL: ReadonlySet<TerminalActionId> = new Set(
  TERMINAL_COMMAND_ENTRIES.map((entry) => entry.action),
);

describe("parseTerminalCommand", () => {
  it("reads a terminal name and its arguments from a message that is only a command", () => {
    expect(parseTerminalCommand("/undo")?.entry.action).toBe("rewind");
    expect(parseTerminalCommand("  /Checkpoint  ")?.entry.action).toBe("rewind");
    expect(parseTerminalCommand("/rename My new title")).toMatchObject({
      entry: { action: "rename" },
      argument: "My new title",
    });
  });

  it("does not read a command from the middle of a message or from an unknown name", () => {
    expect(parseTerminalCommand("please /undo that")).toBeNull();
    expect(parseTerminalCommand("/not-a-command")).toBeNull();
    expect(parseTerminalCommand("undo")).toBeNull();
  });
});

describe("resolveTerminalCommand", () => {
  it("resolves a name whose action is available", () => {
    expect(
      resolveTerminalCommand("/diff", { availableActions: ALL, providerCommandNames: [] }),
    ).toMatchObject({ entry: { action: "diff" }, argument: "" });
  });

  it("does not resolve a name whose action is unavailable", () => {
    expect(
      resolveTerminalCommand("/diff", {
        availableActions: new Set<TerminalActionId>(["rewind"]),
        providerCommandNames: [],
      }),
    ).toBeNull();
  });

  it("leaves a name the provider reports to the provider, by name or by alias", () => {
    expect(
      resolveTerminalCommand("/context", {
        availableActions: ALL,
        providerCommandNames: ["Context"],
      }),
    ).toBeNull();
    expect(
      resolveTerminalCommand("/undo", { availableActions: ALL, providerCommandNames: ["undo"] }),
    ).toBeNull();
    expect(
      resolveTerminalCommand("/rewind", { availableActions: ALL, providerCommandNames: ["undo"] }),
    ).toMatchObject({ entry: { action: "rewind" } });
  });

  it("opens provider settings for /mcp so MCP servers can be managed", () => {
    expect(
      resolveTerminalCommand("/mcp", { availableActions: ALL, providerCommandNames: [] }),
    ).toMatchObject({ entry: { action: "settings-providers" }, argument: "" });
    expect(
      resolveTerminalCommand("/MCP", { availableActions: ALL, providerCommandNames: [] }),
    ).toMatchObject({ entry: { action: "settings-providers" }, argument: "" });
  });

  it("leaves /mcp to a provider that reports its own mcp command", () => {
    expect(
      resolveTerminalCommand("/mcp", { availableActions: ALL, providerCommandNames: ["mcp"] }),
    ).toBeNull();
    expect(
      resolveTerminalCommand("/MCP", { availableActions: ALL, providerCommandNames: ["MCP"] }),
    ).toBeNull();
  });
});

describe("availableTerminalCommandEntries", () => {
  it("lists only entries whose action is available", () => {
    const entries = availableTerminalCommandEntries({
      availableActions: new Set<TerminalActionId>(["rewind", "diff"]),
      providerCommandNames: [],
    });
    expect(entries.map((entry) => entry.action)).toEqual(["rewind", "diff"]);
  });

  it("drops an entry once the provider reports its primary name", () => {
    const entries = availableTerminalCommandEntries({
      availableActions: ALL,
      providerCommandNames: ["context"],
    });
    expect(entries.some((entry) => entry.action === "context")).toBe(false);
  });

  it("keeps an entry and hides only the aliases the provider reports", () => {
    const entries = availableTerminalCommandEntries({
      availableActions: ALL,
      providerCommandNames: ["undo"],
    });
    const rewind = entries.find((entry) => entry.action === "rewind");
    expect(rewind?.names).toEqual(["rewind", "checkpoint"]);
  });

  it("offers mcp once with its own description and drops it when the provider reports it", () => {
    const entries = availableTerminalCommandEntries({
      availableActions: ALL,
      providerCommandNames: [],
    });
    const mcp = entries.filter((entry) => entry.names.includes("mcp"));
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatchObject({
      action: "settings-providers",
      names: ["mcp"],
      description: "Open provider settings, where MCP servers are managed",
    });

    const reported = availableTerminalCommandEntries({
      availableActions: ALL,
      providerCommandNames: ["mcp"],
    });
    expect(reported.some((entry) => entry.names.includes("mcp"))).toBe(false);
  });
});

describe("TERMINAL_COMMAND_ENTRIES", () => {
  it("maps every terminal name to a Houston action that exists", () => {
    const names = TERMINAL_COMMAND_ENTRIES.flatMap((entry) => entry.names);
    expect(names).toEqual([
      "rewind",
      "checkpoint",
      "undo",
      "context",
      "effort",
      "fast",
      "permissions",
      "diff",
      "fork",
      "branch",
      "rename",
      "theme",
      "keybindings",
      "config",
      "status",
      "login",
      "logout",
      "doctor",
      "mcp",
      "voice",
    ]);
    for (const entry of TERMINAL_COMMAND_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("does not offer a name that only exists in a terminal", () => {
    const names = new Set(TERMINAL_COMMAND_ENTRIES.flatMap((entry) => entry.names));
    for (const name of ["exit", "quit", "vim", "ide", "tui", "statusline", "terminal-setup"]) {
      expect(names.has(name)).toBe(false);
    }
  });
});
