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
import { ScheduledTaskRunStatus } from "../scheduledTask.ts";

/** The bounds settings, runs and the brief are checked against; a refusal names the bound. */
export const HOUSTON_NIGHT_SHIFT_LIMITS = {
  /** Start to hard stop. */
  windowMinutes: 16 * 60,
  runNowMinMinutes: 15,
  runNowMaxMinutes: 960,
  /** A run of an hour or more wraps up this long before its hard stop. */
  wrapUpLeadMinutes: 45,
  liveWorkersMin: 1,
  liveWorkersMax: 12,
  workersMin: 1,
  workersMax: 4,
  checks: 20,
  checkBytes: 1_024,
  competitors: 10,
  directionChars: 2_000,
  /** Every free-text field of the settings together. */
  textChars: 24_000,
  relatedChangesMin: 2,
  relatedChangesMax: 20,
  backlogMin: 1,
  backlogMax: 10,
  smokeFlows: 20,
  /** Live runs of one server, across projects. */
  liveRunsPerServer: 2,
  /** Runs a snapshot lists, newest first. */
  runsPerSnapshot: 30,
  /** Preflight floors, in bytes. */
  memoryFloorBytes: 6 * 1024 ** 3,
  diskFloorBytes: 20 * 1024 ** 3,
  /** The brief must fit one provider turn (PROVIDER_SEND_TURN_MAX_INPUT_CHARS). */
  briefChars: 120_000,
  /** The idle rule: a nudge after this many idle minutes, a settle after as many more. */
  idleMinutes: 10,
  /** How long a stop waits for the crew's runs to end before stopping the orchestrator. */
  crewStopSeconds: 60,
  reportBytes: 256 * 1024,
} as const;

export const NightRunPhase = Schema.Literals([
  "preflight",
  "refused",
  "running",
  "wrappingUp",
  "settled",
]);
export type NightRunPhase = typeof NightRunPhase.Type;

export const NightRunTrigger = Schema.Literals(["scheduled", "catchUp", "manual", "imported"]);
export type NightRunTrigger = typeof NightRunTrigger.Type;

export const NightStopReason = Schema.Literals([
  "report",
  "hardStop",
  "stopped",
  "idle",
  "orchestratorEnded",
  "orchestratorLimited",
  "serverRestart",
  "launchFailed",
  "imported",
]);
export type NightStopReason = typeof NightStopReason.Type;

export const NightCrewRole = Schema.Literals([
  "orchestrator",
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type NightCrewRole = typeof NightCrewRole.Type;

export const NightEntryKind = Schema.Literals([
  "plan",
  "pr",
  "lesson",
  "flaky",
  "decision",
  "deferred",
  "studied",
  "pick",
  "verdict",
]);
export type NightEntryKind = typeof NightEntryKind.Type;

export const NightGateState = Schema.Literals(["passed", "failed", "pending", "notApplicable"]);
export type NightGateState = typeof NightGateState.Type;

export const NightGates = Schema.Struct({
  checks: NightGateState,
  ci: NightGateState,
  verify: NightGateState,
  review: NightGateState,
  qa: NightGateState,
});
export type NightGates = typeof NightGates.Type;

export const NightPreflightStatus = Schema.Literals(["ok", "warn", "block"]);
export type NightPreflightStatus = typeof NightPreflightStatus.Type;

export const NightFocusLevel = Schema.Literals(["off", "low", "normal", "high"]);
export type NightFocusLevel = typeof NightFocusLevel.Type;

export const NightOutput = Schema.Literals(["prs", "mergeQueue"]);
export type NightOutput = typeof NightOutput.Type;

export const NightVerification = Schema.Literals(["light", "standard"]);
export type NightVerification = typeof NightVerification.Type;

export const NightPullRequestSize = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("one") }),
  Schema.Struct({ kind: Schema.Literal("related"), maxChanges: Schema.Int }),
]);
export type NightPullRequestSize = typeof NightPullRequestSize.Type;

/** A local clock time, HH:MM. */
export const NightClock = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
export type NightClock = typeof NightClock.Type;

export const NightCheck = Schema.Struct({ command: Schema.String, source: Schema.String });
export type NightCheck = typeof NightCheck.Type;

export const NightFocus = Schema.Struct({
  reliability: NightFocusLevel,
  performance: NightFocusLevel,
  uiPolish: NightFocusLevel,
  competitorGaps: NightFocusLevel,
  docsAccuracy: NightFocusLevel,
  testGaps: NightFocusLevel,
});
export type NightFocus = typeof NightFocus.Type;

/** The settings document; the server checks its bounds and the scheduled task holds start and nights. */
export const HoustonNightShiftSettings = Schema.Struct({
  v: Schema.Literal(3),
  enabled: Schema.Boolean,
  window: Schema.Struct({ wrapUp: NightClock, hardStop: NightClock }),
  focus: NightFocus,
  direction: Schema.String,
  competitors: Schema.Array(Schema.Struct({ repo: Schema.String })),
  orchestrator: ModelSelection,
  /** Fallback order. */
  workers: Schema.Array(ModelSelection),
  liveWorkers: Schema.Int,
  reviewer: Schema.NullOr(ModelSelection),
  backlog: Schema.Struct({ enabled: Schema.Boolean, max: Schema.Int }),
  output: NightOutput,
  prSize: NightPullRequestSize,
  screenshots: Schema.Boolean,
  appQa: Schema.Struct({
    enabled: Schema.Boolean,
    startCommand: Schema.NullOr(Schema.String),
    source: Schema.NullOr(Schema.String),
    address: Schema.NullOr(Schema.String),
    smokeFlows: Schema.Array(Schema.String),
  }),
  holdForQa: Schema.Boolean,
  checks: Schema.Array(NightCheck),
  verification: NightVerification,
  questions: Schema.Literal("park"),
});
export type HoustonNightShiftSettings = typeof HoustonNightShiftSettings.Type;

export const PreflightItem = Schema.Struct({
  /** `memory`, `orchestrator_not_ready:<instance>`, ... */
  id: Schema.String,
  status: NightPreflightStatus,
  label: Schema.String,
  detail: Schema.String,
  limit: Schema.optional(Schema.String),
  actual: Schema.optional(Schema.String),
});
export type PreflightItem = typeof PreflightItem.Type;

export const NightInterruption = Schema.Struct({ at: IsoDateTime, detail: Schema.String });
export type NightInterruption = typeof NightInterruption.Type;

export const NightRun = Schema.Struct({
  id: PositiveInt,
  projectId: ProjectId,
  trigger: NightRunTrigger,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  phase: NightRunPhase,
  stopReason: Schema.NullOr(NightStopReason),
  stopDetail: Schema.NullOr(Schema.String),
  orchestratorThreadId: Schema.NullOr(ThreadId),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  wrapUpAt: Schema.NullOr(IsoDateTime),
  hardStopAt: Schema.NullOr(IsoDateTime),
  wrapUpSent: Schema.Boolean,
  endedAt: Schema.NullOr(IsoDateTime),
  preflight: Schema.Array(PreflightItem),
  interruptions: Schema.Array(NightInterruption),
  summary: Schema.NullOr(Schema.String),
  reportPath: Schema.NullOr(Schema.String),
  /** `held`, `released`, or `unavailable: <why>`; null before a start takes it. */
  keepAwake: Schema.NullOr(Schema.String),
});
export type NightRun = typeof NightRun.Type;

export const NightCrewMember = Schema.Struct({
  runId: PositiveInt,
  threadId: ThreadId,
  taskId: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  role: NightCrewRole,
  providerInstanceId: Schema.String,
  requestedInstanceId: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type NightCrewMember = typeof NightCrewMember.Type;

export const NightShiftScheduleSummary = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  enabled: Schema.Boolean,
  timeOfDay: Schema.String,
  /** 0 is Sunday; empty is no night selected. */
  weekdays: Schema.Array(Schema.Int),
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
});
export type NightShiftScheduleSummary = typeof NightShiftScheduleSummary.Type;

export const HoustonNightShiftSnapshot = Schema.Struct({
  projectId: ProjectId,
  settings: Schema.NullOr(HoustonNightShiftSettings),
  revision: NonNegativeInt,
  schedule: Schema.NullOr(NightShiftScheduleSummary),
  detected: Schema.Struct({
    checks: Schema.Array(NightCheck),
    startCommand: Schema.NullOr(NightCheck),
  }),
  liveRun: Schema.NullOr(NightRun),
  crew: Schema.Array(NightCrewMember),
  runs: Schema.Array(NightRun),
  /** Live workers plus one review and one test slot. */
  crewCap: NonNegativeInt,
});
export type HoustonNightShiftSnapshot = typeof HoustonNightShiftSnapshot.Type;

export const NightShiftOverviewRow = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  live: Schema.Boolean,
  lastRun: Schema.NullOr(
    Schema.Struct({ runId: PositiveInt, headline: Schema.String, endedAt: IsoDateTime }),
  ),
});
export type NightShiftOverviewRow = typeof NightShiftOverviewRow.Type;

export const HoustonNightShiftOverviewEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("overview"), rows: Schema.Array(NightShiftOverviewRow) }),
  /** Once per settled run. */
  Schema.Struct({
    type: Schema.Literal("notice"),
    projectId: ProjectId,
    runId: PositiveInt,
    headline: Schema.String,
  }),
]);
export type HoustonNightShiftOverviewEvent = typeof HoustonNightShiftOverviewEvent.Type;

export const HoustonNightShiftProjectInput = Schema.Struct({ projectId: ProjectId });
export type HoustonNightShiftProjectInput = typeof HoustonNightShiftProjectInput.Type;

export const HoustonNightShiftOverviewInput = Schema.Struct({});
export type HoustonNightShiftOverviewInput = typeof HoustonNightShiftOverviewInput.Type;

export const HoustonNightShiftUpdateInput = Schema.Struct({
  projectId: ProjectId,
  settings: HoustonNightShiftSettings,
  expectedRevision: NonNegativeInt,
});
export type HoustonNightShiftUpdateInput = typeof HoustonNightShiftUpdateInput.Type;

export const HoustonNightShiftPreflightInput = Schema.Struct({
  projectId: ProjectId,
  durationMinutes: Schema.optional(Schema.Int),
});
export type HoustonNightShiftPreflightInput = typeof HoustonNightShiftPreflightInput.Type;

export const HoustonNightShiftPreflightResult = Schema.Struct({
  items: Schema.Array(PreflightItem),
  startAt: IsoDateTime,
  wrapUpAt: IsoDateTime,
  hardStopAt: IsoDateTime,
});
export type HoustonNightShiftPreflightResult = typeof HoustonNightShiftPreflightResult.Type;

export const HoustonNightShiftRunNowInput = Schema.Struct({
  projectId: ProjectId,
  durationMinutes: Schema.Int,
});
export type HoustonNightShiftRunNowInput = typeof HoustonNightShiftRunNowInput.Type;

export const HoustonNightShiftRunNowResult = Schema.Struct({
  runId: PositiveInt,
  threadId: ThreadId,
});
export type HoustonNightShiftRunNowResult = typeof HoustonNightShiftRunNowResult.Type;

export const HoustonNightShiftRunInput = Schema.Struct({ runId: PositiveInt });
export type HoustonNightShiftRunInput = typeof HoustonNightShiftRunInput.Type;

export const HoustonNightShiftWrapUpResult = Schema.Struct({ wrapUpAt: IsoDateTime });
export type HoustonNightShiftWrapUpResult = typeof HoustonNightShiftWrapUpResult.Type;

export const HoustonNightShiftStopResult = Schema.Struct({
  endedAt: IsoDateTime,
  stopReason: NightStopReason,
});
export type HoustonNightShiftStopResult = typeof HoustonNightShiftStopResult.Type;

export const HoustonNightShiftEmptyResult = Schema.Struct({});
export type HoustonNightShiftEmptyResult = typeof HoustonNightShiftEmptyResult.Type;

export const HoustonNightShiftErrorKind = Schema.Literals([
  "invalid",
  "not_found",
  "conflict",
  "busy",
  "unsupported",
  "limit",
  "blocked",
  "remote",
]);
export type HoustonNightShiftErrorKind = typeof HoustonNightShiftErrorKind.Type;

export class HoustonNightShiftError extends Schema.TaggedError<HoustonNightShiftError>()(
  "HoustonNightShiftError",
  {
    kind: HoustonNightShiftErrorKind,
    message: Schema.String,
    operation: Schema.String,
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
    /** The preflight items of a `blocked` start. */
    items: Schema.optional(Schema.Array(PreflightItem)),
  },
) {}

/** A ledger entry as the morning's methods answer it. */
export const NightEntry = Schema.Struct({
  id: PositiveInt,
  runId: PositiveInt,
  kind: NightEntryKind,
  title: Schema.String,
  theme: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(PositiveInt),
  taskNumber: Schema.NullOr(PositiveInt),
  headSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  visible: Schema.Boolean,
  qaPassed: Schema.Boolean,
  body: Schema.String,
  choice: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type NightEntry = typeof NightEntry.Type;

export const NightRemoteChange = Schema.Struct({
  ref: Schema.String,
  oldSha: Schema.NullOr(Schema.String),
  newSha: Schema.NullOr(Schema.String),
});
export type NightRemoteChange = typeof NightRemoteChange.Type;

export const NightCost = Schema.Struct({
  members: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      providerInstanceId: Schema.String,
      hours: Schema.Number,
    }),
  ),
  instances: Schema.Record(Schema.String, Schema.Number),
  tokens: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Literal("not tracked")]),
  ),
});
export type NightCost = typeof NightCost.Type;

export const NightReportClaim = Schema.Struct({
  plan: PositiveInt,
  /** The claim's index in its plan, from 0. */
  index: NonNegativeInt,
  claim: Schema.String,
  verdict: Schema.NullOr(Schema.Literals(["passed", "failed"])),
  evidence: Schema.NullOr(Schema.String),
  fault: Schema.NullOr(Schema.String),
});
export type NightReportClaim = typeof NightReportClaim.Type;

export const NightReportPullRequest = Schema.Struct({
  entryId: PositiveInt,
  number: PositiveInt,
  url: Schema.NullOr(Schema.String),
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  /** merged, closed, open, or null while unknown. */
  fate: Schema.NullOr(Schema.String),
  visible: Schema.Boolean,
  held: Schema.Boolean,
  qaPassed: Schema.Boolean,
  gates: NightGates,
  failedChecks: Schema.Array(
    Schema.Struct({ name: Schema.String, url: Schema.NullOr(Schema.String) }),
  ),
  claims: Schema.Array(NightReportClaim),
});
export type NightReportPullRequest = typeof NightReportPullRequest.Type;

export const NightReportDecision = Schema.Struct({
  entryId: PositiveInt,
  title: Schema.String,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  recommendation: Schema.NullOr(Schema.String),
  choice: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type NightReportDecision = typeof NightReportDecision.Type;

export const NightReportEventKind = Schema.Literals([
  "remoteChange",
  "audit",
  "interruption",
  "limit",
  "substitution",
  "gate",
  "ci",
]);
export type NightReportEventKind = typeof NightReportEventKind.Type;

export const HoustonNightReport = Schema.Struct({
  runId: PositiveInt,
  headline: Schema.String,
  summary: Schema.NullOr(Schema.String),
  decisions: Schema.Struct({
    open: Schema.Array(NightReportDecision),
    answered: Schema.Array(NightReportDecision),
  }),
  pullRequests: Schema.Array(
    Schema.Struct({ theme: Schema.String, pullRequests: Schema.Array(NightReportPullRequest) }),
  ),
  mergeOrder: Schema.Array(PositiveInt),
  picks: Schema.Array(
    Schema.Struct({
      taskNumber: PositiveInt,
      title: Schema.String,
      status: Schema.NullOr(Schema.String),
    }),
  ),
  /** Remote changes outside Houston first. */
  events: Schema.Array(
    Schema.Struct({
      kind: NightReportEventKind,
      at: Schema.NullOr(Schema.String),
      text: Schema.String,
    }),
  ),
  remoteChanges: Schema.Array(NightRemoteChange),
  cost: Schema.NullOr(NightCost),
  /** `report.md`, at most `reportReadBytes`. */
  markdown: Schema.String,
  truncated: Schema.Boolean,
});
export type HoustonNightReport = typeof HoustonNightReport.Type;

/** The most of `report.md` the report method answers. */
export const HOUSTON_NIGHT_REPORT_READ_BYTES = 1024 * 1024;

export const HoustonNightShiftDecideInput = Schema.Struct({
  entryId: PositiveInt,
  choice: Schema.String.check(Schema.isMaxLength(500)),
});
export type HoustonNightShiftDecideInput = typeof HoustonNightShiftDecideInput.Type;

export const HoustonNightShiftEntryInput = Schema.Struct({ entryId: PositiveInt });
export type HoustonNightShiftEntryInput = typeof HoustonNightShiftEntryInput.Type;

/** Pull requests one Close may name. */
export const HOUSTON_NIGHT_CLOSE_MAX = 50;

export const HoustonNightShiftCloseInput = Schema.Struct({
  runId: PositiveInt,
  numbers: Schema.Array(PositiveInt).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HOUSTON_NIGHT_CLOSE_MAX),
  ),
});
export type HoustonNightShiftCloseInput = typeof HoustonNightShiftCloseInput.Type;

export const HoustonNightShiftCloseResult = Schema.Struct({
  closed: Schema.Array(PositiveInt),
  skipped: Schema.Array(Schema.Struct({ number: PositiveInt, reason: Schema.String })),
});
export type HoustonNightShiftCloseResult = typeof HoustonNightShiftCloseResult.Type;

export const NightImportCounts = Schema.Struct({
  settings: NonNegativeInt,
  runs: NonNegativeInt,
  entries: NonNegativeInt,
});
export type NightImportCounts = typeof NightImportCounts.Type;

export const HoustonNightShiftImportStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: Schema.String,
    workspaces: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        projectId: Schema.NullOr(ProjectId),
        runs: NonNegativeInt,
      }),
    ),
    runs: NonNegativeInt,
  }),
  Schema.Struct({ state: Schema.Literal("imported"), at: IsoDateTime, counts: NightImportCounts }),
  Schema.Struct({ state: Schema.Literal("blocked"), reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
export type HoustonNightShiftImportStatus = typeof HoustonNightShiftImportStatus.Type;

export const HoustonNightShiftImportResult = Schema.Struct({
  imported: NightImportCounts,
  notes: Schema.Array(Schema.String),
});
export type HoustonNightShiftImportResult = typeof HoustonNightShiftImportResult.Type;

/** The bounds of what a run's crew records through the `houston_night_*` tools. */
export const HOUSTON_NIGHT_LEDGER_LIMITS = {
  entriesPerRun: 200,
  decisionsPerRun: 20,
  pullRequestsPerRun: 30,
  claimsMin: 1,
  claimsMax: 20,
  optionsMin: 2,
  optionsMax: 5,
  summaryChars: 200,
} as const;

export const HoustonNightToolErrorKind = Schema.Literals([
  "invalid",
  "limit",
  "not_in_run",
  "refused",
  "remote",
  "unsupported",
]);
export type HoustonNightToolErrorKind = typeof HoustonNightToolErrorKind.Type;

/** A `houston_night_*` refusal; `limit` carries the bound and the value. */
export class HoustonNightToolError extends Schema.TaggedError<HoustonNightToolError>()(
  "HoustonNightToolError",
  {
    kind: HoustonNightToolErrorKind,
    tool: Schema.String,
    message: Schema.String,
    limit: Schema.optional(Schema.Number),
    actual: Schema.optional(Schema.Number),
  },
) {}
