// The checks on a bot's fields, its account and its short name, as pure functions. A refusal names
// the operation, the limit and the value, and never repeats the instructions.
import type { ModelSelection } from "@houston-app/contracts";
import {
  HOUSTON_BOT_LIMITS,
  HoustonBotError,
  type HoustonBotSaveInput,
} from "@houston-app/contracts/houston/bots";

const LIMITS = HOUSTON_BOT_LIMITS;
const COMBINING_MARKS = /\p{M}+/gu;
const NOT_SLUG_CHARS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const CONTROL_OR_LINE_BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/u;
/** Leaves room in a 64-character short name for the number that tells two apart. */
const SLUG_BASE_CHARS = 56;
/** The driver whose accounts a bot may use. */
const BOT_DRIVER = "claudeAgent";

export const BOTS_OFF_MESSAGE = "Bots are off. Turn on Labs ▸ Bots.";

/** The client session a write came from. */
export interface BotActor {
  readonly sessionId: string;
  readonly label: string;
}

export const refuse = (
  kind: HoustonBotError["kind"],
  operation: string,
  message: string,
  extra: { readonly field?: string; readonly limit?: number; readonly actual?: number } = {},
) =>
  new HoustonBotError({ kind, operation, message: `${operation} refused: ${message}`, ...extra });

export const refuseOff = (operation: string) =>
  new HoustonBotError({ kind: "off", operation, message: BOTS_OFF_MESSAGE });

export const refuseUnknownBot = (operation: string, botId: string) =>
  refuse("not_found", operation, `no bot ${botId}`, { field: "botId" });

export const encodeModelSelection = (selection: ModelSelection): string =>
  JSON.stringify(selection);

/** The first field of `input` that is out of bounds, or null. */
export const checkBot = (operation: string, input: HoustonBotSaveInput): HoustonBotError | null => {
  for (const [field, limit] of [
    ["name", LIMITS.nameChars],
    ["mark", LIMITS.markChars],
    ["job", LIMITS.jobChars],
    ["instructions", LIMITS.instructionsChars],
  ] as const) {
    const actual = input[field].length;
    if (actual > limit) {
      return refuse("limit", operation, `${field} is ${actual} characters; the limit is ${limit}`, {
        field,
        limit,
        actual,
      });
    }
  }
  if (input.name.trim().length === 0) {
    return refuse("invalid", operation, "name is empty; a bot needs a name", { field: "name" });
  }
  for (const field of ["name", "mark", "job"] as const) {
    if (CONTROL_OR_LINE_BREAK.test(input[field])) {
      return refuse("invalid", operation, `${field} must be one line without control characters`, {
        field,
      });
    }
  }
  for (const [field, bounds] of [
    ["maxAtOnce", LIMITS.atOnce],
    ["maxStartsPerDay", LIMITS.startsPerDay],
    ["maxMinutes", LIMITS.minutes],
  ] as const) {
    const actual = input[field];
    if (!Number.isInteger(actual)) {
      return refuse("invalid", operation, `${field} is ${actual}; it must be a whole number`, {
        field,
      });
    }
    if (actual < bounds.min || actual > bounds.max) {
      return refuse(
        "limit",
        operation,
        `${field} is ${actual}; it must be ${bounds.min} to ${bounds.max}`,
        { field, limit: actual < bounds.min ? bounds.min : bounds.max, actual },
      );
    }
  }
  for (const [field, actual, limit, unit] of [
    ["otherProjectIds", input.otherProjectIds.length, LIMITS.otherProjects, "projects"],
    [
      "modelSelection",
      encodeModelSelection(input.modelSelection).length,
      LIMITS.modelSelectionChars,
      "characters",
    ],
  ] as const) {
    if (actual > limit) {
      return refuse("limit", operation, `${field} is ${actual} ${unit}; the limit is ${limit}`, {
        field,
        limit,
        actual,
      });
    }
  }
  return null;
};

/** A bot's account must be a Claude account; `driver` is undefined for an account Houston lacks. */
export const checkAccount = (
  operation: string,
  instanceId: string,
  driver: string | undefined,
): HoustonBotError | null => {
  const extra = { field: "modelSelection" };
  if (driver === undefined) {
    return refuse("not_found", operation, `no provider account ${instanceId}`, extra);
  }
  if (driver === BOT_DRIVER) return null;
  return refuse(
    "unsupported",
    operation,
    `${instanceId} is a ${driver} account; a bot's account must be a Claude account`,
    extra,
  );
};

/** The short name `name` gives: lowercase letters, digits and hyphens. */
export const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NOT_SLUG_CHARS, "-")
    .replace(EDGE_HYPHENS, "")
    .slice(0, SLUG_BASE_CHARS)
    .replace(EDGE_HYPHENS, "") || "bot";

/** `base`, or `base` with the first number from 2 that is not taken. */
export const freeSlug = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base}-${number}`)) number += 1;
  return `${base}-${number}`;
};
