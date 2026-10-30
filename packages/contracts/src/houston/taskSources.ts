import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId } from "../baseSchemas.ts";
import { HoustonTaskRef } from "./tasks.ts";

/** The bounds task sources are checked against; a refusal names the bound and the value. */
export const HOUSTON_TASK_SOURCE_LIMITS = {
  /** The decode bound of any one settings text; the rules refuse narrower values by name. */
  fieldBytes: 4_096,
  /** The decode bound of any one settings list. */
  listItems: 256,
  activeStatuses: 32,
  statusValueBytes: 100,
  propertyIdBytes: 200,
  /** Characters of a refused value a refusal quotes. */
  quotedChars: 120,
  /** Windows Credential Manager holds about 2,560 bytes per secret; one bound on every platform. */
  tokenBytes: 2_048,
} as const;

export const HoustonTaskSourceProvider = Schema.Literals(["github_issues", "notion"]);
export type HoustonTaskSourceProvider = typeof HoustonTaskSourceProvider.Type;

export const HOUSTON_TASK_SOURCE_PROVIDERS: ReadonlyArray<HoustonTaskSourceProvider> = [
  "github_issues",
  "notion",
];

const Text = Schema.String.check(Schema.isMaxLength(HOUSTON_TASK_SOURCE_LIMITS.fieldBytes));
const OptionalText = Schema.optionalKey(Schema.NullOr(Text));

/** The Notion status option each task status maps to; null leaves it unmapped. */
export const HoustonTaskSourceStatusMapping = Schema.Struct({
  todo: Schema.NullOr(Text),
  inProgress: Schema.NullOr(Text),
  inReview: Schema.NullOr(Text),
  done: Schema.NullOr(Text),
  canceled: Schema.NullOr(Text),
});
export type HoustonTaskSourceStatusMapping = typeof HoustonTaskSourceStatusMapping.Type;

/** What a client sets; an absent field is stored empty. */
export const HoustonTaskSourceSettingsInput = Schema.Struct({
  enabled: Schema.Boolean,
  githubRepository: OptionalText,
  githubLabel: OptionalText,
  githubAssignedUser: OptionalText,
  notionDataSourceId: OptionalText,
  notionTitlePropertyId: OptionalText,
  notionDescriptionPropertyId: OptionalText,
  notionStatusPropertyId: OptionalText,
  notionAssigneePropertyId: OptionalText,
  notionProjectRelationPropertyId: OptionalText,
  notionAssigneeUserId: OptionalText,
  notionActiveStatusValues: Schema.optionalKey(
    Schema.Array(Text).check(Schema.isMaxLength(HOUSTON_TASK_SOURCE_LIMITS.listItems)),
  ),
  notionProjectsDataSourceId: OptionalText,
  notionProjectTitlePropertyId: OptionalText,
  notionProjectDescriptionPropertyId: OptionalText,
  notionPrUrlPropertyId: OptionalText,
  notionStatusMapping: Schema.optionalKey(HoustonTaskSourceStatusMapping),
});
export type HoustonTaskSourceSettingsInput = typeof HoustonTaskSourceSettingsInput.Type;

/** One provider's settings for a project, as stored, with its sync state. Never a token. */
export const HoustonTaskSourceSettings = Schema.Struct({
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
  enabled: Schema.Boolean,
  /** 0 for a provider never set. */
  revision: NonNegativeInt,
  githubRepository: Schema.NullOr(Schema.String),
  githubLabel: Schema.NullOr(Schema.String),
  githubAssignedUser: Schema.NullOr(Schema.String),
  notionDataSourceId: Schema.NullOr(Schema.String),
  notionTitlePropertyId: Schema.NullOr(Schema.String),
  notionDescriptionPropertyId: Schema.NullOr(Schema.String),
  notionStatusPropertyId: Schema.NullOr(Schema.String),
  notionAssigneePropertyId: Schema.NullOr(Schema.String),
  notionProjectRelationPropertyId: Schema.NullOr(Schema.String),
  notionAssigneeUserId: Schema.NullOr(Schema.String),
  notionActiveStatusValues: Schema.Array(Schema.String),
  notionProjectsDataSourceId: Schema.NullOr(Schema.String),
  notionProjectTitlePropertyId: Schema.NullOr(Schema.String),
  notionProjectDescriptionPropertyId: Schema.NullOr(Schema.String),
  notionPrUrlPropertyId: Schema.NullOr(Schema.String),
  notionStatusMapping: HoustonTaskSourceStatusMapping,
  /** Whether the OS keychain holds this project's token; always false for GitHub Issues. */
  hasCredential: Schema.Boolean,
  lastSyncAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type HoustonTaskSourceSettings = typeof HoustonTaskSourceSettings.Type;

export const HoustonTaskSourceConflictField = Schema.Literals([
  "title",
  "description",
  "status",
  "project.title",
  "project.description",
  "project.identity",
]);
export type HoustonTaskSourceConflictField = typeof HoustonTaskSourceConflictField.Type;

export const HoustonTaskSourceConflict = Schema.Struct({
  field: Schema.String,
  base: Schema.String,
  local: Schema.String,
  remote: Schema.String,
});
export type HoustonTaskSourceConflict = typeof HoustonTaskSourceConflict.Type;

/** A tracker's grouping of items (a milestone, a related project page); unverified text. */
export const HoustonTaskSourceProjectSnapshot = Schema.Struct({
  externalId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.String,
  unverified: Schema.Boolean,
});
export type HoustonTaskSourceProjectSnapshot = typeof HoustonTaskSourceProjectSnapshot.Type;

/** The three-way view of a linked item: the last agreed base, the task, and the tracker. */
export const HoustonTaskSourceSnapshot = Schema.Struct({
  base: Schema.Record(Schema.String, Schema.String),
  local: Schema.Record(Schema.String, Schema.String),
  remote: Schema.Record(Schema.String, Schema.String),
  conflicts: Schema.Array(HoustonTaskSourceConflict),
  revision: PositiveInt,
  projectExternalId: Schema.NullOr(Schema.String),
  project: Schema.NullOr(HoustonTaskSourceProjectSnapshot),
});
export type HoustonTaskSourceSnapshot = typeof HoustonTaskSourceSnapshot.Type;

export const HoustonTaskSourceSyncState = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["current", "diverged", "pending"]) }),
  Schema.Struct({ state: Schema.Literal("error"), message: Schema.String }),
]);
export type HoustonTaskSourceSyncState = typeof HoustonTaskSourceSyncState.Type;

export const HoustonTaskSourceLinkSource = Schema.Literals(["source", "pull_request"]);
export type HoustonTaskSourceLinkSource = typeof HoustonTaskSourceLinkSource.Type;

export const HoustonTaskSourceLink = Schema.Struct({
  taskId: PositiveInt,
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
  externalId: Schema.String,
  url: Schema.String,
  source: HoustonTaskSourceLinkSource,
  remoteRev: Schema.NullOr(Schema.String),
  bodyHash: Schema.NullOr(Schema.String),
  fetchedAt: Schema.NullOr(IsoDateTime),
  syncedAt: Schema.NullOr(IsoDateTime),
  snapshot: HoustonTaskSourceSnapshot,
  syncState: HoustonTaskSourceSyncState,
});
export type HoustonTaskSourceLink = typeof HoustonTaskSourceLink.Type;

export const HoustonTaskSourceErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "conflict",
  "credential_missing",
  "keychain_unavailable",
  "remote",
  "unsupported",
]);
export type HoustonTaskSourceErrorKind = typeof HoustonTaskSourceErrorKind.Type;

/** A refusal. It never carries a token. */
export class HoustonTaskSourceError extends Schema.TaggedError<HoustonTaskSourceError>()(
  "HoustonTaskSourceError",
  {
    kind: HoustonTaskSourceErrorKind,
    message: Schema.String,
    operation: Schema.String,
    field: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
    expected: Schema.optional(Schema.Number),
  },
) {}

export const HoustonTaskSourceSyncResult = Schema.Struct({
  provider: HoustonTaskSourceProvider,
  lastSyncAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type HoustonTaskSourceSyncResult = typeof HoustonTaskSourceSyncResult.Type;

export const HoustonTaskSourceStreamEvent = Schema.Union([
  Schema.Struct({
    snapshot: Schema.Struct({ settings: Schema.Array(HoustonTaskSourceSettings) }),
  }),
  Schema.Struct({ state: HoustonTaskSourceSyncResult }),
  Schema.Struct({
    links: Schema.Struct({ taskId: PositiveInt, links: Schema.Array(HoustonTaskSourceLink) }),
  }),
]);
export type HoustonTaskSourceStreamEvent = typeof HoustonTaskSourceStreamEvent.Type;

export const HoustonTaskSourceImportCounts = Schema.Struct({
  settings: NonNegativeInt,
  links: NonNegativeInt,
});
export type HoustonTaskSourceImportCounts = typeof HoustonTaskSourceImportCounts.Type;

export const HoustonTaskSourceImportStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: Schema.String,
    settings: NonNegativeInt,
    links: NonNegativeInt,
  }),
  Schema.Struct({
    state: Schema.Literal("imported"),
    at: IsoDateTime,
    counts: HoustonTaskSourceImportCounts,
  }),
  Schema.Struct({ state: Schema.Literal("blocked"), reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
export type HoustonTaskSourceImportStatus = typeof HoustonTaskSourceImportStatus.Type;

/** `notes` counts each kind of v1 row the import left behind. */
export const HoustonTaskSourceImportResult = Schema.Struct({
  imported: HoustonTaskSourceImportCounts,
  notes: Schema.Array(Schema.String),
});
export type HoustonTaskSourceImportResult = typeof HoustonTaskSourceImportResult.Type;

// Inputs.

export const HoustonTaskSourceProjectInput = Schema.Struct({ projectId: ProjectId });
export type HoustonTaskSourceProjectInput = typeof HoustonTaskSourceProjectInput.Type;

export const HoustonTaskSourceSettingsSetInput = Schema.Struct({
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
  /** The revision the client read; 0 for a provider never set. Absent skips the check. */
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  settings: HoustonTaskSourceSettingsInput,
});
export type HoustonTaskSourceSettingsSetInput = typeof HoustonTaskSourceSettingsSetInput.Type;

export const HoustonTaskSourceCredentialSetInput = Schema.Struct({
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
  token: Schema.Redacted(Schema.String),
});
export type HoustonTaskSourceCredentialSetInput = typeof HoustonTaskSourceCredentialSetInput.Type;

export const HoustonTaskSourceCredentialClearInput = Schema.Struct({
  projectId: ProjectId,
  provider: HoustonTaskSourceProvider,
});
export type HoustonTaskSourceCredentialClearInput =
  typeof HoustonTaskSourceCredentialClearInput.Type;

export const HoustonTaskSourceCredentialResult = Schema.Struct({ hasCredential: Schema.Boolean });
export type HoustonTaskSourceCredentialResult = typeof HoustonTaskSourceCredentialResult.Type;

export const HoustonTaskSourceLinksGetInput = Schema.Struct({ taskId: HoustonTaskRef });
export type HoustonTaskSourceLinksGetInput = typeof HoustonTaskSourceLinksGetInput.Type;

export const HoustonTaskSourceResolution = Schema.Union([
  Schema.Literals(["local", "remote"]),
  Schema.Struct({ custom: Schema.String }),
]);
export type HoustonTaskSourceResolution = typeof HoustonTaskSourceResolution.Type;

export const HoustonTaskSourceConflictResolveInput = Schema.Struct({
  taskId: HoustonTaskRef,
  expectedTaskRevision: PositiveInt,
  /** Required for `project.*` fields. */
  expectedInitiativeRevision: Schema.optionalKey(PositiveInt),
  provider: HoustonTaskSourceProvider,
  externalId: Schema.String,
  field: HoustonTaskSourceConflictField,
  expectedLinkRevision: PositiveInt,
  resolution: HoustonTaskSourceResolution,
});
export type HoustonTaskSourceConflictResolveInput =
  typeof HoustonTaskSourceConflictResolveInput.Type;

export const HoustonTaskSourceImportInput = Schema.Struct({});
export type HoustonTaskSourceImportInput = typeof HoustonTaskSourceImportInput.Type;
