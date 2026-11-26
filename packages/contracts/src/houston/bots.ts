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

/** What started a bot run fixes its kind, and its kind fixes the rules of its thread. */
export const HoustonBotRunKind = Schema.Literals(["asked", "unattended"]);
export type HoustonBotRunKind = typeof HoustonBotRunKind.Type;

const KNOWN_RUN_KINDS: ReadonlySet<string> = new Set(HoustonBotRunKind.literals);

/** For display: a kind this build does not know, from a newer server, decodes to `other`. */
export const HoustonBotRunKindOrOther = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(["asked", "unattended", "other"]),
    SchemaTransformation.transform({
      decode: (kind) =>
        KNOWN_RUN_KINDS.has(kind) ? (kind as HoustonBotRunKind) : ("other" as const),
      encode: (kind): string => kind,
    }),
  ),
);

/** Which tool calls a bot thread may make beyond its refused names. */
export const HoustonBotToolRules = Schema.Struct({
  /** Built-in tools allowed by name; absent allows every one that is not refused. */
  builtinTools: Schema.optional(Schema.Array(Schema.String)),
  /** `reads`: a connector call is refused unless its name says it only reads. */
  connectorTools: Schema.Literals(["all", "reads"]),
  /** Houston tools allowed by name; absent allows every one that is not refused. */
  houstonTools: Schema.optional(Schema.Array(Schema.String)),
  /** `reads`: a shell command may run `gh` only to read. */
  gh: Schema.Literals(["any", "reads"]),
});
export type HoustonBotToolRules = typeof HoustonBotToolRules.Type;

/** A kind's rules as a bot run started with them; stored, so a later build does not widen them. */
export const HoustonBotRunPolicy = Schema.Struct({
  kind: HoustonBotRunKind,
  /** The mode the kind fixes; absent leaves the thread's own mode. */
  runtimeMode: Schema.optional(RuntimeMode),
  refusedTools: Schema.Array(Schema.String),
  rules: HoustonBotToolRules,
  /** No question, approval or dialog waits for a person. */
  neverAsk: Schema.Boolean,
  /** Minutes of running time, for a kind that has a limit. */
  maxMinutes: Schema.optional(PositiveInt),
});
export type HoustonBotRunPolicy = typeof HoustonBotRunPolicy.Type;

/** What a provider applies to one turn of a bot thread. */
export const HoustonBotProviderPolicy = Schema.Struct({
  botName: Schema.String,
  kind: HoustonBotRunKind,
  /** A delegated child of the bot thread, which hands back no result of its own. */
  child: Schema.Boolean,
  refusedTools: Schema.Array(Schema.String),
  rules: HoustonBotToolRules,
  neverAsk: Schema.Boolean,
  instructionsAppend: Schema.optional(Schema.String),
});
export type HoustonBotProviderPolicy = typeof HoustonBotProviderPolicy.Type;

/** Stamped by the server on the thread of a bot run, for display; policy reads the bot run. */
export const HoustonBotThreadMark = Schema.Struct({
  botId: Schema.String,
  botRunId: Schema.String,
  kind: HoustonBotRunKindOrOther,
});
export type HoustonBotThreadMark = typeof HoustonBotThreadMark.Type;
