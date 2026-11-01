import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ScheduledTaskRunStatus, ScheduledTaskSchedule } from "../scheduledTask.ts";
import { HoustonTaskSummary } from "./tasks.ts";

/** The bounds a review and its answer are checked against; a refusal names the bound. */
export const HOUSTON_HARNESS_LIMITS = {
  /** Reviews a snapshot lists, newest first. */
  reviewsPerSnapshot: 50,
  /** Open findings with no linked task the overview suggests. */
  suggested: 50,
  /** The largest report, findings file or report read a client receives. */
  reportBytes: 1024 * 1024,
  summaryChars: 200,
  findings: 100,
  verifications: 100,
  keyChars: 80,
  titleChars: 200,
  textChars: 2_000,
  applyPromptChars: 8_000,
  quotes: 5,
  quoteChars: 300,
  sessions: 50,
  sessionChars: 80,
  /** A verdict needs this many sessions after its task landed, or it reads inconclusive. */
  minimumSessionsAfterLanding: 3,
  corrections: 2,
} as const;

export const HoustonHarnessReviewStatus = Schema.Literals([
  "preparing",
  "running",
  "published",
  "failed",
]);
export type HoustonHarnessReviewStatus = typeof HoustonHarnessReviewStatus.Type;

export const HoustonHarnessTrigger = Schema.Literals(["scheduled", "manual", "imported"]);
export type HoustonHarnessTrigger = typeof HoustonHarnessTrigger.Type;

export const HoustonHarnessFindingPhase = Schema.Literals([
  "open",
  "fixing",
  "awaitingVerification",
  "notSeen",
  "resolved",
  "dismissed",
]);
export type HoustonHarnessFindingPhase = typeof HoustonHarnessFindingPhase.Type;

/** What the user decided about a finding or a defect. */
export const HoustonHarnessDecisionState = Schema.Literals(["open", "dismissed", "resolved"]);
export type HoustonHarnessDecisionState = typeof HoustonHarnessDecisionState.Type;

export const HoustonHarnessVerdict = Schema.Literals(["gone", "stillPresent", "inconclusive"]);
export type HoustonHarnessVerdict = typeof HoustonHarnessVerdict.Type;

export const HoustonHarnessDefectSource = Schema.Literals(["agent", "detector"]);
export type HoustonHarnessDefectSource = typeof HoustonHarnessDefectSource.Type;

export const HoustonHarnessDefectDestination = Schema.Literals(["houston", "project"]);
export type HoustonHarnessDefectDestination = typeof HoustonHarnessDefectDestination.Type;

export const HoustonHarnessDefectDecision = Schema.Literals(["dismiss", "notABug", "reopen"]);
export type HoustonHarnessDefectDecision = typeof HoustonHarnessDefectDecision.Type;

/** `manual` sets the review up paused, so it runs only on Run review now. */
export const HoustonHarnessSchedule = Schema.Literals(["weekly", "daily", "manual"]);
export type HoustonHarnessSchedule = typeof HoustonHarnessSchedule.Type;

export const HoustonHarnessReview = Schema.Struct({
  id: PositiveInt,
  projectId: ProjectId,
  trigger: HoustonHarnessTrigger,
  status: HoustonHarnessReviewStatus,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  threadId: Schema.NullOr(ThreadId),
  providerInstanceId: Schema.NullOr(Schema.String),
  /** The run directory, relative to the project root. */
  runDir: Schema.String,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  windowSince: Schema.NullOr(IsoDateTime),
  windowUntil: Schema.NullOr(IsoDateTime),
  threads: Schema.NullOr(NonNegativeInt),
  prompts: Schema.NullOr(NonNegativeInt),
  costUsd: Schema.NullOr(Schema.Number),
  findingCount: Schema.NullOr(NonNegativeInt),
  corrections: NonNegativeInt,
  summary: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type HoustonHarnessReview = typeof HoustonHarnessReview.Type;

/** The fix task a finding links; filled once fix tasks exist. */
export const HoustonHarnessFindingTask = Schema.Struct({
  taskId: PositiveInt,
  key: Schema.String,
  status: Schema.String,
  landedAt: Schema.NullOr(IsoDateTime),
});
export type HoustonHarnessFindingTask = typeof HoustonHarnessFindingTask.Type;

export const HoustonHarnessVerification = Schema.Struct({
  reviewId: PositiveInt,
  taskId: PositiveInt,
  verdict: HoustonHarnessVerdict,
  sessionsAfter: NonNegativeInt,
  evidence: Schema.Array(Schema.String),
});
export type HoustonHarnessVerification = typeof HoustonHarnessVerification.Type;

export const HoustonHarnessFinding = Schema.Struct({
  key: Schema.String,
  /** The newest published review that raised the key. */
  reviewId: PositiveInt,
  title: Schema.String,
  category: Schema.String,
  confidence: Schema.String,
  sessions: Schema.Array(Schema.String),
  count: NonNegativeInt,
  quotes: Schema.Array(Schema.String),
  recommendationKind: Schema.String,
  target: Schema.String,
  recommendation: Schema.String,
  applyPrompt: Schema.String,
  state: HoustonHarnessDecisionState,
  decidedAt: Schema.NullOr(IsoDateTime),
  /** A decision older than the review that raised the key again. */
  recurred: Schema.Boolean,
  phase: HoustonHarnessFindingPhase,
  lastSeenReviewId: PositiveInt,
  task: Schema.NullOr(HoustonHarnessFindingTask),
  verification: Schema.NullOr(HoustonHarnessVerification),
});
export type HoustonHarnessFinding = typeof HoustonHarnessFinding.Type;

export const HoustonSuspectedDefect = Schema.Struct({
  key: Schema.String,
  source: HoustonHarnessDefectSource,
  detector: Schema.NullOr(Schema.String),
  title: Schema.String,
  description: Schema.String,
  evidence: Schema.Array(Schema.String),
  destination: HoustonHarnessDefectDestination,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  count: PositiveInt,
  issueUrl: Schema.NullOr(Schema.String),
  state: HoustonHarnessDecisionState,
  recurred: Schema.Boolean,
});
export type HoustonSuspectedDefect = typeof HoustonSuspectedDefect.Type;

/** The upstream scheduled task the review runs as; edits, pause and delete happen there. */
export const HoustonHarnessScheduleSummary = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  modelSelection: ModelSelection,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
});
export type HoustonHarnessScheduleSummary = typeof HoustonHarnessScheduleSummary.Type;

export const HoustonHarnessSnapshot = Schema.Struct({
  projectId: ProjectId,
  schedule: Schema.NullOr(HoustonHarnessScheduleSummary),
  reviews: Schema.Array(HoustonHarnessReview),
  runningReviewId: Schema.NullOr(PositiveInt),
  findings: Schema.Array(HoustonHarnessFinding),
  defects: Schema.Array(HoustonSuspectedDefect),
  seenReviewId: NonNegativeInt,
});
export type HoustonHarnessSnapshot = typeof HoustonHarnessSnapshot.Type;

export const HoustonHarnessOverviewRow = Schema.Struct({
  projectId: ProjectId,
  open: NonNegativeInt,
  fixing: NonNegativeInt,
  awaitingVerification: NonNegativeInt,
  notSeen: NonNegativeInt,
  resolved: NonNegativeInt,
  dismissed: NonNegativeInt,
  suspectedDefects: NonNegativeInt,
  latestPublishedReviewId: Schema.NullOr(PositiveInt),
  seenReviewId: NonNegativeInt,
  /** Undecided defects plus findings needing a look published after the seen cursor. */
  attention: NonNegativeInt,
});
export type HoustonHarnessOverviewRow = typeof HoustonHarnessOverviewRow.Type;

export const HoustonHarnessSuggestion = Schema.Struct({
  projectId: ProjectId,
  finding: HoustonHarnessFinding,
});
export type HoustonHarnessSuggestion = typeof HoustonHarnessSuggestion.Type;

export const HoustonHarnessOverview = Schema.Struct({
  rows: Schema.Array(HoustonHarnessOverviewRow),
  suggested: Schema.Array(HoustonHarnessSuggestion),
});
export type HoustonHarnessOverview = typeof HoustonHarnessOverview.Type;

export const HoustonHarnessOverviewEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("overview"), overview: HoustonHarnessOverview }),
  Schema.Struct({
    type: Schema.Literal("defectNotice"),
    projectId: ProjectId,
    count: PositiveInt,
    title: Schema.String,
  }),
]);
export type HoustonHarnessOverviewEvent = typeof HoustonHarnessOverviewEvent.Type;

export const HoustonHarnessProjectInput = Schema.Struct({ projectId: ProjectId });
export type HoustonHarnessProjectInput = typeof HoustonHarnessProjectInput.Type;

export const HoustonHarnessOverviewInput = Schema.Struct({});
export type HoustonHarnessOverviewInput = typeof HoustonHarnessOverviewInput.Type;

export const HoustonHarnessSetupInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
  schedule: HoustonHarnessSchedule,
});
export type HoustonHarnessSetupInput = typeof HoustonHarnessSetupInput.Type;

export const HoustonHarnessRunNowResult = Schema.Struct({
  reviewId: PositiveInt,
  threadId: ThreadId,
});
export type HoustonHarnessRunNowResult = typeof HoustonHarnessRunNowResult.Type;

export const HoustonHarnessReportInput = Schema.Struct({ reviewId: PositiveInt });
export type HoustonHarnessReportInput = typeof HoustonHarnessReportInput.Type;

export const HoustonHarnessReportResult = Schema.Struct({
  markdown: Schema.String,
  truncated: Schema.Boolean,
});
export type HoustonHarnessReportResult = typeof HoustonHarnessReportResult.Type;

export const HoustonHarnessDecideInput = Schema.Struct({
  projectId: ProjectId,
  key: Schema.String.check(Schema.isMaxLength(200)),
  state: HoustonHarnessDecisionState,
});
export type HoustonHarnessDecideInput = typeof HoustonHarnessDecideInput.Type;

export const HoustonHarnessMarkSeenInput = Schema.Struct({
  projectId: ProjectId,
  reviewId: NonNegativeInt,
});
export type HoustonHarnessMarkSeenInput = typeof HoustonHarnessMarkSeenInput.Type;

export const HoustonHarnessMarkSeenResult = Schema.Struct({ seenReviewId: NonNegativeInt });
export type HoustonHarnessMarkSeenResult = typeof HoustonHarnessMarkSeenResult.Type;

export const HoustonHarnessCreateTaskInput = Schema.Struct({
  projectId: ProjectId,
  key: Schema.String.check(Schema.isMaxLength(200)),
  /** Replaces the finding's apply prompt in the task description. */
  applyPrompt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65_536))),
});
export type HoustonHarnessCreateTaskInput = typeof HoustonHarnessCreateTaskInput.Type;

export const HoustonHarnessCreateTaskResult = Schema.Struct({ task: HoustonTaskSummary });
export type HoustonHarnessCreateTaskResult = typeof HoustonHarnessCreateTaskResult.Type;

/** The bounds a defect report and its issue are checked against; a refusal names the bound. */
export const HOUSTON_DEFECT_LIMITS = {
  titleChars: 120,
  evidence: 10,
  evidenceChars: 500,
  /** Defects a project holds; a new one replaces the oldest decided one. */
  perProject: 200,
  issueTitleChars: 256,
  issueBodyChars: 60_000,
  duplicates: 10,
  searchWords: 6,
} as const;

/** Where a `houston` defect is filed. */
export const HOUSTON_DEFECT_REPOSITORY = "theogmiguel/houston";

export const HoustonDefectReportResult = Schema.Struct({
  recorded: Schema.Literal(true),
  key: Schema.String,
  count: PositiveInt,
  note: Schema.String,
});
export type HoustonDefectReportResult = typeof HoustonDefectReportResult.Type;

export const HoustonDefectDecideInput = Schema.Struct({
  projectId: ProjectId,
  key: Schema.String.check(Schema.isMaxLength(200)),
  decision: HoustonHarnessDefectDecision,
});
export type HoustonDefectDecideInput = typeof HoustonDefectDecideInput.Type;

export const HoustonDefectDraftInput = Schema.Struct({
  projectId: ProjectId,
  key: Schema.String.check(Schema.isMaxLength(200)),
});
export type HoustonDefectDraftInput = typeof HoustonDefectDraftInput.Type;

export const HoustonDefectIssueMatch = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  url: Schema.String,
});
export type HoustonDefectIssueMatch = typeof HoustonDefectIssueMatch.Type;

/** Which GitHub credential a file would use: `settings`, `app`, `env` or `gh`. */
export const HoustonDefectCredential = Schema.Struct({
  source: Schema.String,
  account: Schema.NullOr(Schema.String),
});
export type HoustonDefectCredential = typeof HoustonDefectCredential.Type;

export const HoustonDefectIssueDraft = Schema.Struct({
  destination: HoustonHarnessDefectDestination,
  repository: Schema.String,
  /** Null when no GitHub credential resolves; filing would then fail. */
  credential: Schema.NullOr(HoustonDefectCredential),
  title: Schema.String,
  body: Schema.String,
  /** What filing sends, to which repository, as which account. */
  transmits: Schema.String,
  duplicates: Schema.Array(HoustonDefectIssueMatch),
  note: Schema.NullOr(Schema.String),
});
export type HoustonDefectIssueDraft = typeof HoustonDefectIssueDraft.Type;

export const HoustonDefectFileInput = Schema.Struct({
  projectId: ProjectId,
  key: Schema.String.check(Schema.isMaxLength(200)),
  // Bounded loosely here; the service refuses outside 1-256 and 1-60,000 naming the bound.
  title: Schema.String.check(Schema.isMaxLength(1_000_000)),
  body: Schema.String.check(Schema.isMaxLength(1_000_000)),
  repository: Schema.String.check(Schema.isMaxLength(200)),
  commentOn: Schema.optionalKey(PositiveInt),
});
export type HoustonDefectFileInput = typeof HoustonDefectFileInput.Type;

export const HoustonDefectFileResult = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  note: Schema.NullOr(Schema.String),
});
export type HoustonDefectFileResult = typeof HoustonDefectFileResult.Type;

export const HoustonHarnessImportCounts = Schema.Struct({
  reviews: NonNegativeInt,
  findings: NonNegativeInt,
  decisions: NonNegativeInt,
  links: NonNegativeInt,
  verifications: NonNegativeInt,
  defects: NonNegativeInt,
});
export type HoustonHarnessImportCounts = typeof HoustonHarnessImportCounts.Type;

export const HoustonHarnessImportStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: Schema.String,
    reviews: NonNegativeInt,
    defects: NonNegativeInt,
  }),
  Schema.Struct({
    state: Schema.Literal("imported"),
    at: IsoDateTime,
    counts: HoustonHarnessImportCounts,
  }),
  Schema.Struct({ state: Schema.Literal("blocked"), reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
export type HoustonHarnessImportStatus = typeof HoustonHarnessImportStatus.Type;

export const HoustonHarnessImportResult = Schema.Struct({
  imported: HoustonHarnessImportCounts,
  /** One line per v1 row the import could not keep. */
  notes: Schema.Array(Schema.String),
});
export type HoustonHarnessImportResult = typeof HoustonHarnessImportResult.Type;

export const HoustonHarnessEmptyResult = Schema.Struct({});
export type HoustonHarnessEmptyResult = typeof HoustonHarnessEmptyResult.Type;

export const HoustonHarnessErrorKind = Schema.Literals([
  "invalid",
  "not_found",
  "conflict",
  "busy",
  "unsupported",
  "limit",
  "access_off",
  "read_only",
  "remote",
]);
export type HoustonHarnessErrorKind = typeof HoustonHarnessErrorKind.Type;

export class HoustonHarnessError extends Schema.TaggedError<HoustonHarnessError>()(
  "HoustonHarnessError",
  {
    kind: HoustonHarnessErrorKind,
    message: Schema.String,
    operation: Schema.String,
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
  },
) {}
