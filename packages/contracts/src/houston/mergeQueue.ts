import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, ProjectId } from "../baseSchemas.ts";

/** The bounds the merge queue is checked against; a refusal names the bound and the value. */
export const HOUSTON_MERGE_QUEUE_LIMITS = {
  entries: 32,
  commandBytes: 1_024,
  timeLimitMinutes: { minimum: 1, maximum: 240 },
  defaultTimeLimitMinutes: 30,
  /** The snapshot's log: the last 24 hours, at most 50 rows. */
  snapshotLogHours: 24,
  snapshotLogRows: 50,
  /** Log rows older than this are deleted on the next insert. */
  logDays: 30,
  /** Each queued pull request is read again after this many seconds. */
  readIntervalSeconds: 60,
} as const;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** A full commit id, the only head a merge may be pinned to. */
export const HoustonMergeQueueHeadSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i));
export type HoustonMergeQueueHeadSha = typeof HoustonMergeQueueHeadSha.Type;

export const HoustonMergeQueueCommand = Schema.String.check(
  Schema.makeFilter(
    (value: string) => utf8Bytes(value) <= HOUSTON_MERGE_QUEUE_LIMITS.commandBytes,
    { expected: `at most ${HOUSTON_MERGE_QUEUE_LIMITS.commandBytes} bytes` },
  ),
);

export const HoustonMergeQueueTimeLimit = Schema.Int.check(
  Schema.isBetween(HOUSTON_MERGE_QUEUE_LIMITS.timeLimitMinutes),
);

export const HoustonMergeQueueGateKind = Schema.Literals([
  "mergeable",
  "reviewThreads",
  "reviewer",
  "verification",
]);
export type HoustonMergeQueueGateKind = typeof HoustonMergeQueueGateKind.Type;

export const HoustonMergeQueueGateState = Schema.Literals([
  "passed",
  "failed",
  "pending",
  "notApplicable",
]);
export type HoustonMergeQueueGateState = typeof HoustonMergeQueueGateState.Type;

export const HoustonMergeQueueGate = Schema.Struct({
  kind: HoustonMergeQueueGateKind,
  state: HoustonMergeQueueGateState,
  reason: Schema.NullOr(Schema.String),
});
export type HoustonMergeQueueGate = typeof HoustonMergeQueueGate.Type;

export const HoustonMergeQueueStatus = Schema.Literals([
  "ready",
  "waitingForSlot",
  "verifying",
  "blocked",
  "paused",
  "watching",
  "fixing",
  "parked",
]);
export type HoustonMergeQueueStatus = typeof HoustonMergeQueueStatus.Type;

/** A passed verification: the head rebased onto `baseRef` at `baseSha` became `verifiedSha`. */
export const HoustonMergeQueueVerification = Schema.Struct({
  baseRef: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  verifiedSha: Schema.String,
  at: IsoDateTime,
  /** Checks GitHub reported on `headSha` when the queue pushed `verifiedSha` over it. */
  headChecks: Schema.optionalKey(NonNegativeInt),
});
export type HoustonMergeQueueVerification = typeof HoustonMergeQueueVerification.Type;

export const HoustonMergeQueueFailureKind = Schema.Literals([
  "conflict",
  "failed",
  "timedOut",
  "refused",
  "checksFailed",
  "ejected",
]);
export type HoustonMergeQueueFailureKind = typeof HoustonMergeQueueFailureKind.Type;

/** A failure keeps the entry out of line only while its head is `headSha`. */
export const HoustonMergeQueueFailure = Schema.Struct({
  kind: HoustonMergeQueueFailureKind,
  message: Schema.String,
  headSha: Schema.String,
  baseSha: Schema.NullOr(Schema.String),
  files: Schema.Array(Schema.String),
  outputTail: Schema.NullOr(Schema.String),
  /** The owner thread the failure was sent to; null leaves the entry parked. */
  notifiedThreadId: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type HoustonMergeQueueFailure = typeof HoustonMergeQueueFailure.Type;

export const HoustonMergeQueueHandOff = Schema.Literals(["houston", "autoMerge", "mergeQueue"]);
export type HoustonMergeQueueHandOff = typeof HoustonMergeQueueHandOff.Type;

/** What was handed to GitHub; it holds only for the head it names. */
export const HoustonMergeQueueGitHubHold = Schema.Struct({
  mode: HoustonMergeQueueHandOff,
  headSha: Schema.String,
  at: IsoDateTime,
});
export type HoustonMergeQueueGitHubHold = typeof HoustonMergeQueueGitHubHold.Type;

export const HoustonMergeQueueEntry = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
  repository: Schema.String,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  headRef: Schema.String,
  headSha: Schema.String,
  baseRef: Schema.NullOr(Schema.String),
  dependsOn: Schema.NullOr(PositiveInt),
  ownerThreadId: Schema.NullOr(Schema.String),
  /** The rank in line from 1; 0 for an entry out of line (parked, fixing, or behind one). */
  position: NonNegativeInt,
  status: HoustonMergeQueueStatus,
  reason: Schema.NullOr(Schema.String),
  gates: Schema.Array(HoustonMergeQueueGate),
  verification: Schema.NullOr(HoustonMergeQueueVerification),
  failure: Schema.NullOr(HoustonMergeQueueFailure),
  github: Schema.NullOr(HoustonMergeQueueGitHubHold),
  enqueuedAt: IsoDateTime,
  readAt: Schema.NullOr(IsoDateTime),
  verifyingSince: Schema.NullOr(IsoDateTime),
});
export type HoustonMergeQueueEntry = typeof HoustonMergeQueueEntry.Type;

export const HoustonMergeQueueLogKind = Schema.Literals([
  "push",
  "merge",
  "park",
  "restack",
  "retarget",
  "hand_off",
]);
export type HoustonMergeQueueLogKind = typeof HoustonMergeQueueLogKind.Type;

export const HoustonMergeQueueMergeMethod = Schema.Literals(["squash", "merge", "rebase"]);
export type HoustonMergeQueueMergeMethod = typeof HoustonMergeQueueMergeMethod.Type;

export const HoustonMergeQueueLogEntry = Schema.Struct({
  id: PositiveInt,
  kind: HoustonMergeQueueLogKind,
  number: PositiveInt,
  repository: Schema.String,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  /** The pushed branch, or the base a merge moved. */
  refName: Schema.NullOr(Schema.String),
  oldSha: Schema.NullOr(Schema.String),
  newSha: Schema.NullOr(Schema.String),
  /** The merged commit. */
  headSha: Schema.NullOr(Schema.String),
  forkSha: Schema.NullOr(Schema.String),
  method: Schema.NullOr(HoustonMergeQueueMergeMethod),
  detail: Schema.NullOr(Schema.String),
  unattended: Schema.Boolean,
  at: IsoDateTime,
});
export type HoustonMergeQueueLogEntry = typeof HoustonMergeQueueLogEntry.Type;

export const HoustonMergeQueueSettings = Schema.Struct({
  projectId: ProjectId,
  mergeWhenVerified: Schema.Boolean,
  verificationCommand: Schema.String,
  timeLimitMinutes: PositiveInt,
  paused: Schema.Boolean,
  /** 0 for a project never set. */
  revision: NonNegativeInt,
});
export type HoustonMergeQueueSettings = typeof HoustonMergeQueueSettings.Type;

export const HoustonMergeQueueAway = Schema.Struct({
  merged: NonNegativeInt,
  parked: NonNegativeInt,
});
export type HoustonMergeQueueAway = typeof HoustonMergeQueueAway.Type;

export const HoustonMergeQueueSnapshot = Schema.Struct({
  projectId: ProjectId,
  /** In line order. */
  entries: Schema.Array(HoustonMergeQueueEntry),
  /** Newest first. */
  log: Schema.Array(HoustonMergeQueueLogEntry),
  settings: HoustonMergeQueueSettings,
  globalPaused: Schema.Boolean,
  away: HoustonMergeQueueAway,
  /** The hand-off GitHub's last answer chose for the project's base; null before one. */
  handOff: Schema.NullOr(HoustonMergeQueueHandOff),
  /** Why the queue does not move, when it does not: a pause or a refusal to verify. */
  message: Schema.NullOr(Schema.String),
});
export type HoustonMergeQueueSnapshot = typeof HoustonMergeQueueSnapshot.Type;

export const HoustonMergeQueueSummary = Schema.Struct({
  parked: Schema.Array(Schema.Struct({ projectId: ProjectId, parked: NonNegativeInt })),
  globalPaused: Schema.Boolean,
});
export type HoustonMergeQueueSummary = typeof HoustonMergeQueueSummary.Type;

export const HoustonMergeQueueErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_found",
  "conflict",
  "refused",
  "paused",
  "unsupported",
  "remote",
]);
export type HoustonMergeQueueErrorKind = typeof HoustonMergeQueueErrorKind.Type;

export class HoustonMergeQueueError extends Schema.TaggedError<HoustonMergeQueueError>()(
  "HoustonMergeQueueError",
  {
    kind: HoustonMergeQueueErrorKind,
    message: Schema.String,
    operation: Schema.String,
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
    expected: Schema.optional(Schema.Number),
  },
) {}

// Inputs.

export const HoustonMergeQueueProjectInput = Schema.Struct({ projectId: ProjectId });
export type HoustonMergeQueueProjectInput = typeof HoustonMergeQueueProjectInput.Type;

export const HoustonMergeQueueSummaryInput = Schema.Struct({});
export type HoustonMergeQueueSummaryInput = typeof HoustonMergeQueueSummaryInput.Type;

export const HoustonMergeQueueEnqueueInput = Schema.Struct({
  projectId: ProjectId,
  /** A number, or the pull request's URL. */
  pullRequest: Schema.Union([PositiveInt, Schema.String.check(Schema.isMaxLength(2_048))]),
  dependsOn: Schema.optionalKey(Schema.NullOr(PositiveInt)),
});
export type HoustonMergeQueueEnqueueInput = typeof HoustonMergeQueueEnqueueInput.Type;

export const HoustonMergeQueueEntryInput = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
});
export type HoustonMergeQueueEntryInput = typeof HoustonMergeQueueEntryInput.Type;

export const HoustonMergeQueueMergeHeadInput = Schema.Struct({
  projectId: ProjectId,
  number: PositiveInt,
  expectedHeadSha: HoustonMergeQueueHeadSha,
});
export type HoustonMergeQueueMergeHeadInput = typeof HoustonMergeQueueMergeHeadInput.Type;

export const HoustonMergeQueueMergeOutcome = Schema.Literals(["merged", "waiting", "handedOff"]);
export type HoustonMergeQueueMergeOutcome = typeof HoustonMergeQueueMergeOutcome.Type;

export const HoustonMergeQueueMergeHeadResult = Schema.Struct({
  outcome: HoustonMergeQueueMergeOutcome,
  message: Schema.String,
});
export type HoustonMergeQueueMergeHeadResult = typeof HoustonMergeQueueMergeHeadResult.Type;

export const HoustonMergeQueueSettingsSetInput = Schema.Struct({
  projectId: ProjectId,
  mergeWhenVerified: Schema.Boolean,
  verificationCommand: HoustonMergeQueueCommand,
  timeLimitMinutes: HoustonMergeQueueTimeLimit,
  /** The revision the client read; 0 for a project never set. Absent skips the check. */
  expectedRevision: Schema.optionalKey(NonNegativeInt),
});
export type HoustonMergeQueueSettingsSetInput = typeof HoustonMergeQueueSettingsSetInput.Type;

export const HoustonMergeQueuePauseInput = Schema.Struct({
  /** Absent pauses or resumes every queue. */
  projectId: Schema.optionalKey(ProjectId),
  paused: Schema.Boolean,
});
export type HoustonMergeQueuePauseInput = typeof HoustonMergeQueuePauseInput.Type;

export const HoustonMergeQueueMessageResult = Schema.Struct({ message: Schema.String });
export type HoustonMergeQueueMessageResult = typeof HoustonMergeQueueMessageResult.Type;

export const HoustonMergeQueueEmptyResult = Schema.Struct({});
export type HoustonMergeQueueEmptyResult = typeof HoustonMergeQueueEmptyResult.Type;
