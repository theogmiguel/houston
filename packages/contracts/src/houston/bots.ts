import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { RuntimeMode } from "../providerPolicy.ts";

/** The bounds a bot is checked against; a refusal names the bound and the value. */
export const HOUSTON_BOT_LIMITS = {
  bots: 24,
  nameChars: 60,
  /** One or two emoji, or a short glyph. */
  markChars: 16,
  jobChars: 160,
  instructionsChars: 16_000,
  otherProjects: 32,
  /** The account, model and effort as stored JSON. */
  modelSelectionChars: 4_096,
  startsPerDay: { min: 1, max: 48 },
  minutes: { min: 1, max: 240 },
  atOnce: { min: 1, max: 3 },
  /** Revisions one read returns, each with its text. */
  revisionsPage: 20,
  /** How long a change stays on the bot's record of recent changes, and how many it lists. */
  recentChangeDays: 7,
  recentChanges: 20,
} as const;

const KNOWN_CHANGE_FIELDS: ReadonlySet<string> = new Set([
  "full_access",
  "ceilings",
  "account",
  "projects",
  "routine",
]);

/** A field this build does not know, from a newer server, decodes to `other`. */
export const HoustonBotChangeField = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(["full_access", "ceilings", "account", "projects", "routine", "other"]),
    SchemaTransformation.transform({
      decode: (field) =>
        KNOWN_CHANGE_FIELDS.has(field)
          ? (field as "full_access" | "ceilings" | "account" | "projects" | "routine")
          : ("other" as const),
      encode: (field): string => field,
    }),
  ),
);
export type HoustonBotChangeField = typeof HoustonBotChangeField.Type;

/** A change to what a bot may do, and the client that made it. */
export const HoustonBotChange = Schema.Struct({
  field: HoustonBotChangeField,
  at: IsoDateTime,
  byLabel: Schema.String,
});
export type HoustonBotChange = typeof HoustonBotChange.Type;

const revisionFields = {
  n: PositiveInt,
  sha256: Schema.String,
  acceptedAt: IsoDateTime,
  acceptedByLabel: Schema.String,
  /** The revision whose text this one restored. */
  restoredFrom: Schema.NullOr(PositiveInt),
};

export const HoustonBotRevisionInfo = Schema.Struct(revisionFields);
export type HoustonBotRevisionInfo = typeof HoustonBotRevisionInfo.Type;

export const HoustonBotRevision = Schema.Struct({ ...revisionFields, text: Schema.String });
export type HoustonBotRevision = typeof HoustonBotRevision.Type;

/** The current instructions' text is read with `houston.bots.revisions`. */
export const HoustonBot = Schema.Struct({
  id: Schema.String,
  /** Set once from the first name, and never given to another bot. */
  slug: Schema.String,
  name: Schema.String,
  mark: Schema.String,
  job: Schema.String,
  defaultProjectId: ProjectId,
  otherProjectIds: Schema.Array(ProjectId),
  modelSelection: ModelSelection,
  /** The mode of bot runs the owner starts. */
  askedMode: RuntimeMode,
  unattendedFullAccess: Schema.Boolean,
  maxAtOnce: PositiveInt,
  maxStartsPerDay: PositiveInt,
  maxMinutes: PositiveInt,
  enabled: Schema.Boolean,
  readyMade: Schema.NullOr(Schema.String),
  instructions: HoustonBotRevisionInfo,
  /** Newest first. */
  recentChanges: Schema.Array(HoustonBotChange),
  rowRevision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HoustonBot = typeof HoustonBot.Type;

export const HoustonBotErrorKind = Schema.Literals([
  "off",
  "invalid",
  "limit",
  "not_found",
  "conflict",
  "unsupported",
]);
export type HoustonBotErrorKind = typeof HoustonBotErrorKind.Type;

/** A refusal. It never carries a bot's instructions. */
export class HoustonBotError extends Schema.TaggedError<HoustonBotError>()("HoustonBotError", {
  kind: HoustonBotErrorKind,
  message: Schema.String,
  operation: Schema.String,
  field: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
  /** For a conflict, the bot's live row revision. */
  actual: Schema.optional(Schema.Number),
}) {}

export const HoustonBotStreamEvent = Schema.Union([
  Schema.Struct({
    off: Schema.Literal(true),
    /** Bot runs that are still stopping. */
    stopping: NonNegativeInt,
  }),
  Schema.Struct({ snapshot: Schema.Struct({ bots: Schema.Array(HoustonBot) }) }),
  Schema.Struct({ upserted: HoustonBot }),
  Schema.Struct({ deleted: Schema.Struct({ botId: Schema.String }) }),
]);
export type HoustonBotStreamEvent = typeof HoustonBotStreamEvent.Type;

// Inputs carry no length or count bound, so the store's refusal names the limit and the value.

export const HoustonBotEmptyInput = Schema.Struct({});
export type HoustonBotEmptyInput = typeof HoustonBotEmptyInput.Type;

export const HoustonBotSaveInput = Schema.Struct({
  /** The bot and the row revision the client edited; null creates one, switched off. */
  target: Schema.NullOr(Schema.Struct({ botId: Schema.String, expectedRevision: NonNegativeInt })),
  name: Schema.String,
  mark: Schema.String,
  job: Schema.String,
  instructions: Schema.String,
  defaultProjectId: ProjectId,
  otherProjectIds: Schema.Array(ProjectId),
  modelSelection: ModelSelection,
  askedMode: RuntimeMode,
  unattendedFullAccess: Schema.Boolean,
  maxAtOnce: Schema.Number,
  maxStartsPerDay: Schema.Number,
  maxMinutes: Schema.Number,
});
export type HoustonBotSaveInput = typeof HoustonBotSaveInput.Type;

export const HoustonBotRestoreRevisionInput = Schema.Struct({
  botId: Schema.String,
  expectedRevision: NonNegativeInt,
  /** The revision whose text becomes a new revision. */
  n: PositiveInt,
});
export type HoustonBotRestoreRevisionInput = typeof HoustonBotRestoreRevisionInput.Type;

export const HoustonBotSetEnabledInput = Schema.Struct({
  botId: Schema.String,
  enabled: Schema.Boolean,
});
export type HoustonBotSetEnabledInput = typeof HoustonBotSetEnabledInput.Type;

export const HoustonBotDeleteInput = Schema.Struct({ botId: Schema.String });
export type HoustonBotDeleteInput = typeof HoustonBotDeleteInput.Type;

export const HoustonBotDeleteResult = Schema.Struct({ deleted: Schema.Literal(true) });
export type HoustonBotDeleteResult = typeof HoustonBotDeleteResult.Type;

export const HoustonBotRevisionsInput = Schema.Struct({
  botId: Schema.String,
  /** Reads the revisions before this one; absent reads the newest. */
  before: Schema.optionalKey(PositiveInt),
});
export type HoustonBotRevisionsInput = typeof HoustonBotRevisionsInput.Type;

/** Newest first. */
export const HoustonBotRevisionsResult = Schema.Struct({
  revisions: Schema.Array(HoustonBotRevision),
  hasMore: Schema.Boolean,
});
export type HoustonBotRevisionsResult = typeof HoustonBotRevisionsResult.Type;
