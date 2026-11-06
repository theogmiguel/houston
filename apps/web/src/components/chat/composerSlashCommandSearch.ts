import { PROVIDER_DISPLAY_NAMES } from "@houston-app/contracts";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@houston-app/shared/searchRanking";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { scoreProviderSkill } from "../../providerSkillSearch";

const LEADING_SLASHES = /^\/+/;

type SlashSearchItem = Extract<
  ComposerCommandItem,
  { type: "slash-command" | "provider-slash-command" | "skill" }
>;

export type SlashCommandSectionId = "houston" | "provider" | "skills";

export type SlashCommandSection = {
  readonly id: SlashCommandSectionId;
  readonly title: string;
  readonly items: ReadonlyArray<SlashSearchItem>;
};

const SLASH_COMMAND_SECTION_ORDER: ReadonlyArray<SlashCommandSectionId> = [
  "houston",
  "provider",
  "skills",
];

function isSlashSearchItem(item: ComposerCommandItem): item is SlashSearchItem {
  return (
    item.type === "slash-command" || item.type === "provider-slash-command" || item.type === "skill"
  );
}

export function slashCommandSectionId(item: SlashSearchItem): SlashCommandSectionId {
  switch (item.type) {
    case "slash-command":
      return "houston";
    case "provider-slash-command":
      return "provider";
    case "skill":
      return "skills";
  }
}

function slashCommandSectionTitle(
  id: SlashCommandSectionId,
  items: ReadonlyArray<SlashSearchItem>,
): string {
  if (id === "houston") return "Houston";
  if (id === "skills") return "Skills";
  const provider = items.find((item) => item.type === "provider-slash-command")?.provider;
  return provider ? (PROVIDER_DISPLAY_NAMES[provider] ?? provider) : "Provider";
}

/** Sections in menu order; an origin with no item left after filtering is omitted. */
export function slashCommandSections(
  items: ReadonlyArray<ComposerCommandItem>,
): SlashCommandSection[] {
  const slashItems = items.filter(isSlashSearchItem);
  return SLASH_COMMAND_SECTION_ORDER.flatMap((id) => {
    const sectionItems = slashItems.filter((item) => slashCommandSectionId(item) === id);
    return sectionItems.length === 0
      ? []
      : [{ id, title: slashCommandSectionTitle(id, sectionItems), items: sectionItems }];
  });
}

function orderSlashCommandItemsBySection(items: ReadonlyArray<SlashSearchItem>): SlashSearchItem[] {
  return SLASH_COMMAND_SECTION_ORDER.flatMap((id) =>
    items.filter((item) => slashCommandSectionId(item) === id),
  );
}

/** Provider commands, `/side` and `/btw` work only at the message start. */
export function slashCommandItemsForPromptPosition(
  items: ReadonlyArray<SlashSearchItem>,
  isAtPromptStart: boolean,
): SlashSearchItem[] {
  if (isAtPromptStart) {
    return [...items];
  }
  return items.filter(
    (item) =>
      item.type === "skill" ||
      (item.type === "slash-command" && item.command !== "side" && item.command !== "btw"),
  );
}

function scoreSlashCommandItem(item: SlashSearchItem, query: string): number | null {
  if (item.type === "skill") {
    if (query === "skill") {
      return 0;
    }
    const skillQuery = query.startsWith("skill:") ? query.slice("skill:".length) : query;
    const skillScore = skillQuery ? scoreProviderSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) {
      return skillScore;
    }
    return "skill".startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }

  const primaryValue =
    item.type === "slash-command" ? item.command.toLowerCase() : item.command.name.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchSlashCommandItems(
  items: ReadonlyArray<SlashSearchItem>,
  query: string,
): SlashSearchItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: LEADING_SLASHES });
  if (!normalizedQuery) {
    return [...items];
  }

  const ranked: Array<{
    item: SlashSearchItem;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === "slash-command"
            ? `0\u0000${item.command}`
            : item.type === "provider-slash-command"
              ? `1\u0000${item.command.name}\u0000${item.provider}`
              : `2\u0000${item.skill.name}\u0000${item.provider}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return orderSlashCommandItemsBySection(ranked.map((entry) => entry.item));
}

/** Houston commands that do not come from a provider. */
export function builtInSlashCommandItems(input: {
  readonly planModeUiEnabled: boolean;
  readonly sideChatAvailable: boolean;
  readonly sideChatDisabledReason: string | null;
  readonly claudeInChrome: boolean;
  readonly resumeAvailable: boolean;
}): ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>> {
  return [
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    ...(input.resumeAvailable
      ? ([
          {
            id: "slash:resume",
            type: "slash-command",
            command: "resume",
            label: "/resume",
            description: "Open an earlier Claude Code or Codex session",
          },
        ] as const)
      : []),
    ...(input.claudeInChrome
      ? ([
          {
            id: "slash:chrome",
            type: "slash-command",
            command: "chrome",
            label: "/chrome",
            description: "Use Chrome in this thread; opens the Claude provider setting",
          },
        ] as const)
      : []),
    ...(input.planModeUiEnabled
      ? ([
          {
            id: "slash:plan",
            type: "slash-command",
            command: "plan",
            label: "/plan",
            description: "Switch this thread into plan mode",
          },
          {
            id: "slash:default",
            type: "slash-command",
            command: "default",
            label: "/default",
            description: "Switch this thread back to normal build mode",
          },
        ] as const)
      : []),
    ...(input.sideChatAvailable
      ? ([
          {
            id: "slash:side",
            type: "slash-command",
            command: "side",
            label: "/side",
            description: input.sideChatDisabledReason ?? "Ask a side question in a new side chat",
          },
          {
            id: "slash:btw",
            type: "slash-command",
            command: "btw",
            label: "/btw",
            description: input.sideChatDisabledReason ?? "Same as /side",
          },
        ] as const)
      : []),
  ];
}
