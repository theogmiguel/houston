import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderSkill } from "@houston-app/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  builtInSlashCommandItems,
  searchSlashCommandItems,
  slashCommandSections,
} from "./composerSlashCommandSearch";

type SlashItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function houstonItem(
  command: string,
  description: string,
): Extract<SlashItem, { type: "slash-command" }> {
  return {
    id: `slash:${command}`,
    type: "slash-command",
    command: command as Extract<SlashItem, { type: "slash-command" }>["command"],
    label: `/${command}`,
    description,
  };
}

function providerItem(
  name: string,
  description: string,
): Extract<SlashItem, { type: "provider-slash-command" }> {
  return {
    id: `provider-slash-command:${PROVIDER}:${name}`,
    type: "provider-slash-command",
    provider: PROVIDER,
    command: { name, description },
    label: `/${name}`,
    description,
  };
}

function skillItem(name: string, description: string): Extract<SlashItem, { type: "skill" }> {
  const skill: ServerProviderSkill = {
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    enabled: true,
  };
  return {
    id: `skill:${PROVIDER}:${name}`,
    type: "skill",
    provider: PROVIDER,
    skill,
    label: `/skill:${name}`,
    description,
  };
}

describe("builtInSlashCommandItems", () => {
  const commands = (
    claudeInChrome: boolean,
    resumeAvailable = true,
    freshSessionAvailable = false,
  ) =>
    builtInSlashCommandItems({
      planModeUiEnabled: true,
      sideChatAvailable: true,
      sideChatDisabledReason: null,
      claudeInChrome,
      resumeAvailable,
      freshSessionAvailable,
    }).map((item) => item.command);

  it("offers /chrome when the Claude provider can use it", () => {
    expect(commands(true)).toEqual(["model", "resume", "chrome", "plan", "default", "side", "btw"]);
  });

  it("omits /chrome for other providers", () => {
    expect(commands(false)).toEqual(["model", "resume", "plan", "default", "side", "btw"]);
  });

  it("offers /resume only when a project is selected", () => {
    expect(commands(true, false)).toEqual(["model", "chrome", "plan", "default", "side", "btw"]);
  });

  it("offers /clear when the server supports a fresh session", () => {
    expect(commands(true, true, true)).toEqual([
      "model",
      "resume",
      "chrome",
      "plan",
      "default",
      "side",
      "btw",
      "clear",
    ]);
  });

  it("explains what /resume does", () => {
    const item = builtInSlashCommandItems({
      planModeUiEnabled: false,
      sideChatAvailable: false,
      sideChatDisabledReason: null,
      claudeInChrome: false,
      resumeAvailable: true,
      freshSessionAvailable: false,
    }).find((command) => command.command === "resume");
    expect(item?.label).toBe("/resume");
    expect(item?.description).toBe("Open an earlier Claude Code or Codex session");
  });

  it("explains what /chrome does", () => {
    const item = builtInSlashCommandItems({
      planModeUiEnabled: false,
      sideChatAvailable: false,
      sideChatDisabledReason: null,
      claudeInChrome: true,
      resumeAvailable: false,
      freshSessionAvailable: false,
    }).find((command) => command.command === "chrome");
    expect(item?.label).toBe("/chrome");
    expect(item?.description).toBe("Use Chrome in this thread; opens the Claude provider setting");
  });
});

describe("slashCommandSections", () => {
  it("orders Houston, the provider's display name and Skills", () => {
    const sections = slashCommandSections([
      skillItem("deploy", "Deploy the app"),
      providerItem("compact", "Compact the conversation"),
      houstonItem("model", "Switch response model for this thread"),
    ]);

    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ["houston", "Houston"],
      ["provider", "Claude"],
      ["skills", "Skills"],
    ]);
  });

  it("omits an origin with no item", () => {
    const sections = slashCommandSections([
      houstonItem("model", "Switch response model for this thread"),
      providerItem("compact", "Compact the conversation"),
    ]);

    expect(sections.map((section) => section.title)).toEqual(["Houston", "Claude"]);
  });

  it("keeps the grouping while filtering and hides emptied origins", () => {
    const items = [
      houstonItem("model", "Switch response model for this thread"),
      providerItem("compact", "Compact the conversation"),
      skillItem("deploy", "Deploy the app"),
    ];

    const sections = slashCommandSections(searchSlashCommandItems(items, "compact"));

    expect(sections.map((section) => section.title)).toEqual(["Claude"]);
    expect(sections[0]?.items.map((item) => item.label)).toEqual(["/compact"]);
  });

  it("keeps Houston first even when a skill ranks better", () => {
    const items = [
      houstonItem("model", "Deploy the app in the background"),
      skillItem("deploy", "Deploy the app"),
    ];

    expect(searchSlashCommandItems(items, "deploy").map((item) => item.id)).toEqual([
      "slash:model",
      `skill:${PROVIDER}:deploy`,
    ]);
  });
});
