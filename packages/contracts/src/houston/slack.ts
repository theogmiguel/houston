import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId } from "../baseSchemas.ts";

/** The bounds the Slack intake is checked against; a refusal names the bound and the value. */
export const HOUSTON_SLACK_LIMITS = {
  /** The task-sources bound: Windows Credential Manager holds about 2,560 bytes per secret. */
  tokenBytes: 2_048,
  channels: 16,
  /** The decode bound of a member or channel id. */
  idChars: 32,
  /** A request's text after the bot's mention is stripped. */
  requestBytes: 8_192,
  images: 4,
  imageBytes: 10 * 1024 * 1024,
  workingRuns: 2,
  catchupHours: 24,
  /** The owner's refusal reason and any other dialog text. */
  dialogChars: 2_000,
  /** Characters of the request the owner's message quotes. */
  previewChars: 280,
  titleChars: 72,
  outboxBatch: 10,
  outboxAttempts: 5,
} as const;

export const HoustonSlackLanguage = Schema.Literals(["en", "pt-BR"]);
export type HoustonSlackLanguage = typeof HoustonSlackLanguage.Type;

export const HoustonSlackConnection = Schema.Literals([
  "off",
  "connecting",
  "connected",
  "retrying",
]);
export type HoustonSlackConnection = typeof HoustonSlackConnection.Type;

export const HoustonSlackChannelId = Schema.String.check(
  Schema.isMaxLength(HOUSTON_SLACK_LIMITS.idChars),
  Schema.isPattern(/^[CG][A-Z0-9]+$/),
);

const MemberId = Schema.String.check(Schema.isMaxLength(HOUSTON_SLACK_LIMITS.idChars));

export const HoustonSlackChannelMap = Schema.Struct({
  channelId: HoustonSlackChannelId,
  projectId: ProjectId,
});
export type HoustonSlackChannelMap = typeof HoustonSlackChannelMap.Type;

/** The intake's settings and connection. Never a token. */
export const HoustonSlackInfo = Schema.Struct({
  enabled: Schema.Boolean,
  /** Whether the OS keychain holds both tokens. */
  hasTokens: Schema.Boolean,
  connection: HoustonSlackConnection,
  team: Schema.NullOr(Schema.String),
  botUserId: Schema.NullOr(Schema.String),
  ownerUserId: Schema.NullOr(Schema.String),
  channels: Schema.Array(HoustonSlackChannelMap),
  language: HoustonSlackLanguage,
  lastEventAt: Schema.NullOr(IsoDateTime),
  lastCatchupAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
  /** 0 for settings never saved. */
  revision: NonNegativeInt,
});
export type HoustonSlackInfo = typeof HoustonSlackInfo.Type;

export const HoustonSlackRequestState = Schema.Literals([
  "pending",
  "queued",
  "started",
  "refused",
  "closed",
]);
export type HoustonSlackRequestState = typeof HoustonSlackRequestState.Type;

/** A Slack mention and the task it filed; `taskId` is null when nothing was filed. */
export const HoustonSlackRequest = Schema.Struct({
  taskId: Schema.NullOr(PositiveInt),
  projectId: ProjectId,
  author: Schema.String,
  channelId: Schema.String,
  state: HoustonSlackRequestState,
  /** 1-based, while queued. */
  queuePosition: Schema.optionalKey(PositiveInt),
  permalink: Schema.NullOr(Schema.String),
  statusReaction: Schema.NullOr(Schema.String),
});
export type HoustonSlackRequest = typeof HoustonSlackRequest.Type;

export const HoustonSlackErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "conflict",
  "credential_missing",
  "keychain_unavailable",
  "remote",
  "unsupported",
  "not_slack",
]);
export type HoustonSlackErrorKind = typeof HoustonSlackErrorKind.Type;

/** A refusal. It never carries a token. */
export class HoustonSlackError extends Schema.TaggedError<HoustonSlackError>()(
  "HoustonSlackError",
  {
    kind: HoustonSlackErrorKind,
    message: Schema.String,
    operation: Schema.String,
    field: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
    expected: Schema.optional(Schema.Number),
  },
) {}

export const HoustonSlackStreamEvent = Schema.Union([
  Schema.Struct({
    snapshot: Schema.Struct({
      info: HoustonSlackInfo,
      requests: Schema.Array(HoustonSlackRequest),
    }),
  }),
  Schema.Struct({ info: HoustonSlackInfo }),
  Schema.Struct({ request: HoustonSlackRequest }),
]);
export type HoustonSlackStreamEvent = typeof HoustonSlackStreamEvent.Type;

// Inputs.

export const HoustonSlackEmptyInput = Schema.Struct({});
export type HoustonSlackEmptyInput = typeof HoustonSlackEmptyInput.Type;

/** Both tokens, or neither to enable the intake with the stored ones. */
export const HoustonSlackConnectInput = Schema.Struct({
  appToken: Schema.optionalKey(Schema.Redacted(Schema.String)),
  botToken: Schema.optionalKey(Schema.Redacted(Schema.String)),
});
export type HoustonSlackConnectInput = typeof HoustonSlackConnectInput.Type;

export const HoustonSlackConfigureInput = Schema.Struct({
  /** The revision the client read; 0 for settings never saved. Absent skips the check. */
  expectedRevision: Schema.optionalKey(NonNegativeInt),
  /** Absent keeps the owner; null clears it. */
  ownerUserId: Schema.optionalKey(Schema.NullOr(MemberId)),
  channels: Schema.Array(HoustonSlackChannelMap).check(
    Schema.isMaxLength(HOUSTON_SLACK_LIMITS.channels),
  ),
  language: Schema.optionalKey(HoustonSlackLanguage),
});
export type HoustonSlackConfigureInput = typeof HoustonSlackConfigureInput.Type;

export const HoustonSlackRequestsListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type HoustonSlackRequestsListInput = typeof HoustonSlackRequestsListInput.Type;
