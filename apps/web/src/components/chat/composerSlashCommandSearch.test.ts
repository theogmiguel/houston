import { describe, expect, it } from "vite-plus/test";

import { builtInSlashCommandItems } from "./composerSlashCommandSearch";

describe("builtInSlashCommandItems", () => {
  const commands = (claudeInChrome: boolean) =>
    builtInSlashCommandItems({
      planModeUiEnabled: true,
      sideChatAvailable: true,
      sideChatDisabledReason: null,
      claudeInChrome,
    }).map((item) => item.command);

  it("offers /chrome when the Claude provider can use it", () => {
    expect(commands(true)).toEqual(["model", "chrome", "plan", "default", "side", "btw"]);
  });

  it("omits /chrome for other providers", () => {
    expect(commands(false)).toEqual(["model", "plan", "default", "side", "btw"]);
  });

  it("explains what /chrome does", () => {
    const item = builtInSlashCommandItems({
      planModeUiEnabled: false,
      sideChatAvailable: false,
      sideChatDisabledReason: null,
      claudeInChrome: true,
    }).find((command) => command.command === "chrome");
    expect(item?.label).toBe("/chrome");
    expect(item?.description).toBe("Use Chrome in this thread; opens the Claude provider setting");
  });
});
