import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
} from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";

/** The bounds every write is checked against; a refusal names the bound and the actual value. */
export const HOUSTON_TASK_LIMITS = {
  /** Characters in a title, an acceptance item and an initiative name. */
  titleChars: 200,
  /** UTF-8 bytes in a description, a tracker description or an external URL. */
  descriptionBytes: 65_536,
  commentBytes: 16_384,
  acceptanceItems: 50,
  commentsPerTask: 500,
  /** Tasks the global backlog may hold, archived included. */
  tasks: 5_000,
  /** History rows and runs a detail answers with, newest first. */
  historyPage: 200,
  runsPage: 50,
  reworkRounds: 5,
  /** UTF-8 bytes in a run's brief, checked before anything is created. */
  briefBytes: 16_384,
  /** Implementation runs one task may have live at once. */
  liveImplementationRuns: 1,
  reviewFindings: 100,
  findingPathChars: 512,
  findingMessageChars: 2_000,
  /** Review starts one task may make on one head. */
  reviewAttemptsPerHead: 2,
  /** An automatic review of a diff at or under both is skipped, recording the numbers. */
  reviewSkipMaxLines: 30,
  reviewSkipMaxFiles: 3,
} as const;

export const HoustonTaskStatus = Schema.Literals([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
]);
export type HoustonTaskStatus = typeof HoustonTaskStatus.Type;

export const HoustonTaskPriority = Schema.Literals(["none", "urgent", "high", "medium", "low"]);
export type HoustonTaskPriority = typeof HoustonTaskPriority.Type;

/** Where the Tasks view shows a task; the server decides it. */
export const HoustonTaskQueue = Schema.Literals([
  "your_turn",
  "working",
  "stopped",
  "up_next",
  "none",
]);
export type HoustonTaskQueue = typeof HoustonTaskQueue.Type;

export const HoustonTaskRunState = Schema.Literals([
  "preparing",
  "running",
  "waiting_for_input",
  "validating",
  "handed_back",
  "needs_review",
  "failed",
  "cancelled",
  "interrupted",
]);
export type HoustonTaskRunState = typeof HoustonTaskRunState.Type;

export const HoustonTaskRunKind = Schema.Literals(["implementation", "review"]);
export type HoustonTaskRunKind = typeof HoustonTaskRunKind.Type;

export const HoustonTaskDomainKind = Schema.Literals(["delivery", "slice"]);
export type HoustonTaskDomainKind = typeof HoustonTaskDomainKind.Type;

export const HoustonTaskAccess = Schema.Literals(["off", "read", "write"]);
export type HoustonTaskAccess = typeof HoustonTaskAccess.Type;

export const HoustonTaskPromptDelivery = Schema.Literals(["send", "prefill"]);
export type HoustonTaskPromptDelivery = typeof HoustonTaskPromptDelivery.Type;

export const HoustonTaskReviewMode = Schema.Literals(["manual", "handback", "every_push"]);
export type HoustonTaskReviewMode = typeof HoustonTaskReviewMode.Type;

export const HoustonTaskReviewFocus = Schema.Literals(["bugs", "security", "performance", "full"]);
export type HoustonTaskReviewFocus = typeof HoustonTaskReviewFocus.Type;

export const HoustonTaskReviewOutcome = Schema.Literals(["pass", "fail", "skipped"]);
export type HoustonTaskReviewOutcome = typeof HoustonTaskReviewOutcome.Type;

const KEY_PREFIX = "HOU";

/** A task's display key; the prefix is fixed. */
export const HoustonTaskKey = Schema.String.check(Schema.isPattern(/^HOU-[1-9][0-9]*$/));
export type HoustonTaskKey = typeof HoustonTaskKey.Type;

export const houstonTaskKey = (number: number): string => `${KEY_PREFIX}-${number}`;

/** A task named by its key in any letter case, or by its decimal id. Always a string. */
export const HoustonTaskRef = Schema.String.check(
  Schema.isPattern(/^(?:[Hh][Oo][Uu]-[1-9][0-9]*|[1-9][0-9]*)$/),
);
export type HoustonTaskRef = typeof HoustonTaskRef.Type;

export type ParsedHoustonTaskRef =
  | { readonly kind: "number"; readonly number: number }
  | { readonly kind: "id"; readonly id: number };

/** Null when `ref` is not a key or a decimal id. */
export const parseHoustonTaskRef = (ref: string): ParsedHoustonTaskRef | null => {
  const key = /^[Hh][Oo][Uu]-([1-9][0-9]*)$/.exec(ref);
  if (key !== null) return { kind: "number", number: Number(key[1]) };
  return /^[1-9][0-9]*$/.test(ref) ? { kind: "id", id: Number(ref) } : null;
};

export const HoustonTaskErrorKind = Schema.Literals([
  "conflict",
  "limit",
  "not_found",
  "invalid",
  "cycle",
  "busy",
  "unready",
  "access_off",
  "read_only",
  "unsupported",
]);
export type HoustonTaskErrorKind = typeof HoustonTaskErrorKind.Type;

/** A refusal; `conflict` carries expected and actual revisions, `limit` the limit and value. */
export class HoustonTaskError extends Schema.TaggedError<HoustonTaskError>()("HoustonTaskError", {
  kind: HoustonTaskErrorKind,
  message: Schema.String,
  operation: Schema.String,
  limit: Schema.optional(Schema.Number),
  actual: Schema.optional(Schema.Number),
  expected: Schema.optional(Schema.Number),
}) {}

const TaskId = PositiveInt;

export const HoustonTask = Schema.Struct({
  id: TaskId,
  number: PositiveInt,
  key: HoustonTaskKey,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  description: Schema.String,
  status: HoustonTaskStatus,
  priority: HoustonTaskPriority,
  parentId: Schema.NullOr(TaskId),
  refUrl: Schema.NullOr(Schema.String),
  revision: PositiveInt,
  /** `user`, `agent:<threadId>`, or a `houston:` actor for derived writes. */
  createdBy: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type HoustonTask = typeof HoustonTask.Type;

export const HoustonTaskReviewFinding = Schema.Struct({
  path: Schema.String,
  line: NonNegativeInt,
  severity: Schema.Literals(["high", "medium", "low", "nit"]),
  category: Schema.Literals(["bug", "security", "performance", "other"]),
  message: Schema.String,
});
export type HoustonTaskReviewFinding = typeof HoustonTaskReviewFinding.Type;

export const HoustonTaskReviewVerdict = Schema.Struct({
  headSha: Schema.String,
  verdict: HoustonTaskReviewOutcome,
  focus: HoustonTaskReviewFocus,
  findings: Schema.Array(HoustonTaskReviewFinding),
  skippedReason: Schema.NullOr(Schema.String),
  outdated: Schema.Boolean,
});
export type HoustonTaskReviewVerdict = typeof HoustonTaskReviewVerdict.Type;

/** One attempt at a task. Runs imported from Houston 1 have no thread. */
export const HoustonTaskRun = Schema.Struct({
  id: PositiveInt,
  taskId: TaskId,
  attempt: PositiveInt,
  kind: HoustonTaskRunKind,
  state: HoustonTaskRunState,
  /** A provider instance id, or a Houston 1 agent name on an imported run. */
  provider: Schema.String,
  reviewer: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  baseCommit: Schema.NullOr(Schema.String),
  initialRevision: NonNegativeInt,
  summary: Schema.NullOr(Schema.String),
  /** Why the run is not running. */
  reason: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  prUrl: Schema.NullOr(Schema.String),
  review: Schema.NullOr(HoustonTaskReviewVerdict),
});
export type HoustonTaskRun = typeof HoustonTaskRun.Type;

/** A task as a list shows it: no description, so a full backlog stays bounded. */
export const HoustonTaskSummary = Schema.Struct({
  id: TaskId,
  number: PositiveInt,
  key: HoustonTaskKey,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.String,
  status: HoustonTaskStatus,
  priority: HoustonTaskPriority,
  parentId: Schema.NullOr(TaskId),
  refUrl: Schema.NullOr(Schema.String),
  revision: PositiveInt,
  createdBy: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  acceptanceChecked: NonNegativeInt,
  acceptanceTotal: NonNegativeInt,
  queue: HoustonTaskQueue,
  ready: Schema.Boolean,
  /** The newest run still in flight, of either kind. */
  openRun: Schema.NullOr(HoustonTaskRun),
});
export type HoustonTaskSummary = typeof HoustonTaskSummary.Type;

export const HoustonTaskAcceptanceItem = Schema.Struct({
  id: PositiveInt,
  position: NonNegativeInt,
  text: Schema.String,
  checkedAt: Schema.NullOr(IsoDateTime),
  checkedBy: Schema.NullOr(Schema.String),
});
export type HoustonTaskAcceptanceItem = typeof HoustonTaskAcceptanceItem.Type;

export const HoustonTaskComment = Schema.Struct({
  id: PositiveInt,
  body: Schema.String,
  author: Schema.String,
  createdAt: IsoDateTime,
});
export type HoustonTaskComment = typeof HoustonTaskComment.Type;

/** One recorded change; `changes` is a JSON object of the fields that moved. */
export const HoustonTaskHistoryEntry = Schema.Struct({
  id: PositiveInt,
  actor: Schema.String,
  action: Schema.String,
  changes: Schema.String,
  createdAt: IsoDateTime,
});
export type HoustonTaskHistoryEntry = typeof HoustonTaskHistoryEntry.Type;

/** A group of deliveries inside a project; Houston 1 called it a project. */
export const HoustonTaskInitiative = Schema.Struct({
  id: PositiveInt,
  /** Null for an initiative imported from a Houston 1 workspace that matched no project. */
  projectId: Schema.NullOr(ProjectId),
  name: Schema.String,
  externalUrl: Schema.NullOr(Schema.String),
  trackerDescription: Schema.NullOr(Schema.String),
  localDecisions: Schema.Array(Schema.String),
  revision: PositiveInt,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type HoustonTaskInitiative = typeof HoustonTaskInitiative.Type;

export const HoustonTaskReadiness = Schema.Struct({
  ready: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  acceptanceTotal: NonNegativeInt,
  unresolvedQuestions: NonNegativeInt,
  unfinishedBlockers: Schema.Array(TaskId),
});
export type HoustonTaskReadiness = typeof HoustonTaskReadiness.Type;

export const HoustonTaskPlanProposal = Schema.Struct({
  description: Schema.String,
  acceptance: Schema.Array(Schema.String),
  pointers: Schema.Array(Schema.String),
  outOfScope: Schema.Array(Schema.String),
  questions: Schema.Array(Schema.String),
});
export type HoustonTaskPlanProposal = typeof HoustonTaskPlanProposal.Type;

export const HoustonTaskPlan = Schema.Struct({
  revision: PositiveInt,
  proposal: HoustonTaskPlanProposal,
  answers: Schema.Array(Schema.Struct({ question: Schema.String, answer: Schema.String })),
  approvedRevision: Schema.NullOr(PositiveInt),
});
export type HoustonTaskPlan = typeof HoustonTaskPlan.Type;

export const HoustonTaskDomain = Schema.Struct({
  taskId: TaskId,
  /** Null for a task with no domain row. */
  kind: Schema.NullOr(HoustonTaskDomainKind),
  initiativeId: Schema.NullOr(PositiveInt),
  /** The parent delivery of a slice. */
  deliveryId: Schema.NullOr(TaskId),
  blockedBy: Schema.Array(TaskId),
  sliceTotal: NonNegativeInt,
  sliceDone: NonNegativeInt,
  readiness: HoustonTaskReadiness,
  plan: Schema.NullOr(HoustonTaskPlan),
});
export type HoustonTaskDomain = typeof HoustonTaskDomain.Type;

export const HoustonTaskPlanningSession = Schema.Struct({
  threadId: ThreadId,
  state: Schema.Literals(["active", "submitted", "cancelled", "exited"]),
  taskRevision: PositiveInt,
  initiativeRevision: Schema.NullOr(PositiveInt),
});
export type HoustonTaskPlanningSession = typeof HoustonTaskPlanningSession.Type;

export const HoustonTaskDetail = Schema.Struct({
  task: HoustonTask,
  acceptance: Schema.Array(HoustonTaskAcceptanceItem),
  /** Oldest first. */
  comments: Schema.Array(HoustonTaskComment),
  /** Newest first, at most `historyPage`. */
  history: Schema.Array(HoustonTaskHistoryEntry),
  /** Newest first, at most `runsPage`. */
  runs: Schema.Array(HoustonTaskRun),
  domain: HoustonTaskDomain,
  planning: Schema.NullOr(HoustonTaskPlanningSession),
});
export type HoustonTaskDetail = typeof HoustonTaskDetail.Type;

/** Counts of unarchived tasks; `yourTurn` is the rail count and `ready` the up-next pool. */
export const HoustonTaskCounts = Schema.Struct({
  yourTurn: NonNegativeInt,
  ready: NonNegativeInt,
  backlog: NonNegativeInt,
  todo: NonNegativeInt,
  inProgress: NonNegativeInt,
  inReview: NonNegativeInt,
  done: NonNegativeInt,
  canceled: NonNegativeInt,
});
export type HoustonTaskCounts = typeof HoustonTaskCounts.Type;

export const HoustonTaskSettings = Schema.Struct({
  access: HoustonTaskAccess,
  startModel: ModelSelection,
  delivery: HoustonTaskPromptDelivery,
  reviewer: Schema.NullOr(ModelSelection),
  reviewMode: HoustonTaskReviewMode,
  focus: HoustonTaskReviewFocus,
  reworkRounds: NonNegativeInt,
});
export type HoustonTaskSettings = typeof HoustonTaskSettings.Type;

/** A missing `reviewMode` is `handback` with a reviewer and `manual` without one. */
export const HoustonTaskSettingsInput = Schema.Struct({
  access: HoustonTaskAccess,
  startModel: ModelSelection,
  delivery: HoustonTaskPromptDelivery,
  reviewer: Schema.NullOr(ModelSelection),
  reviewMode: Schema.optionalKey(HoustonTaskReviewMode),
  focus: HoustonTaskReviewFocus,
  reworkRounds: NonNegativeInt,
});
export type HoustonTaskSettingsInput = typeof HoustonTaskSettingsInput.Type;

export const HoustonTaskImportCounts = Schema.Struct({
  tasks: NonNegativeInt,
  acceptance: NonNegativeInt,
  comments: NonNegativeInt,
  history: NonNegativeInt,
  blockers: NonNegativeInt,
  domains: NonNegativeInt,
  initiatives: NonNegativeInt,
  runs: NonNegativeInt,
  settings: NonNegativeInt,
});
export type HoustonTaskImportCounts = typeof HoustonTaskImportCounts.Type;

export const HoustonTaskImportStatus = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("available"),
    source: Schema.String,
    taskCount: NonNegativeInt,
  }),
  Schema.Struct({
    state: Schema.Literal("imported"),
    at: IsoDateTime,
    counts: HoustonTaskImportCounts,
  }),
  Schema.Struct({ state: Schema.Literal("blocked"), taskCount: NonNegativeInt }),
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
export type HoustonTaskImportStatus = typeof HoustonTaskImportStatus.Type;

/** `notes` names each v1 value the import could not keep and what it stored instead. */
export const HoustonTaskImportResult = Schema.Struct({
  imported: HoustonTaskImportCounts,
  notes: Schema.Array(Schema.String),
});
export type HoustonTaskImportResult = typeof HoustonTaskImportResult.Type;

export const HoustonTaskScope = Schema.Union([
  Schema.Literals(["all", "unassigned"]),
  Schema.Struct({ projectId: ProjectId }),
]);
export type HoustonTaskScope = typeof HoustonTaskScope.Type;

export const HoustonTaskStreamEvent = Schema.Union([
  Schema.Struct({
    snapshot: Schema.Struct({
      tasks: Schema.Array(HoustonTaskSummary),
      counts: HoustonTaskCounts,
      truncated: Schema.Boolean,
    }),
  }),
  Schema.Struct({ changed: HoustonTaskSummary }),
  Schema.Struct({ removed: Schema.Struct({ id: TaskId }) }),
]);
export type HoustonTaskStreamEvent = typeof HoustonTaskStreamEvent.Type;

// Inputs. A patch key that is absent leaves the field; `null` clears a nullable field.

export const HoustonTaskPatch = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(HoustonTaskStatus),
  priority: Schema.optionalKey(HoustonTaskPriority),
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  parentId: Schema.optionalKey(Schema.NullOr(TaskId)),
  refUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Replaces the whole list. */
  acceptance: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HoustonTaskPatch = typeof HoustonTaskPatch.Type;

export const HoustonTaskSubscribeInput = Schema.Struct({ scope: HoustonTaskScope });
export type HoustonTaskSubscribeInput = typeof HoustonTaskSubscribeInput.Type;

export const HoustonTaskGetInput = Schema.Struct({ id: HoustonTaskRef });
export type HoustonTaskGetInput = typeof HoustonTaskGetInput.Type;

export const HoustonTaskSaveInput = Schema.Struct({
  /** Absent creates a task. */
  id: Schema.optionalKey(HoustonTaskRef),
  /** Required to update. */
  expectedRevision: Schema.optionalKey(PositiveInt),
  /** The project a new task is created in when the patch names none. */
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  patch: HoustonTaskPatch,
});
export type HoustonTaskSaveInput = typeof HoustonTaskSaveInput.Type;

export const HoustonTaskCommentInput = Schema.Struct({ id: HoustonTaskRef, body: Schema.String });
export type HoustonTaskCommentInput = typeof HoustonTaskCommentInput.Type;

export const HoustonTaskCheckInput = Schema.Struct({
  id: HoustonTaskRef,
  item: PositiveInt,
  checked: Schema.Boolean,
});
export type HoustonTaskCheckInput = typeof HoustonTaskCheckInput.Type;

export const HoustonTaskArchiveInput = Schema.Struct({
  id: HoustonTaskRef,
  archived: Schema.Boolean,
  expectedRevision: PositiveInt,
});
export type HoustonTaskArchiveInput = typeof HoustonTaskArchiveInput.Type;

export const HoustonTaskInitiativesListInput = Schema.Struct({ projectId: ProjectId });
export type HoustonTaskInitiativesListInput = typeof HoustonTaskInitiativesListInput.Type;

export const HoustonTaskInitiativeSaveInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.optionalKey(PositiveInt),
  expectedRevision: Schema.optionalKey(PositiveInt),
  name: Schema.String,
  externalUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  trackerDescription: Schema.optionalKey(Schema.NullOr(Schema.String)),
  localDecisions: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type HoustonTaskInitiativeSaveInput = typeof HoustonTaskInitiativeSaveInput.Type;

export const HoustonTaskInitiativeArchiveInput = Schema.Struct({
  id: PositiveInt,
  archived: Schema.Boolean,
  expectedRevision: PositiveInt,
});
export type HoustonTaskInitiativeArchiveInput = typeof HoustonTaskInitiativeArchiveInput.Type;

export const HoustonTaskDomainSaveInput = Schema.Struct({
  id: HoustonTaskRef,
  expectedRevision: PositiveInt,
  kind: Schema.optionalKey(HoustonTaskDomainKind),
  initiativeId: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  blockedBy: Schema.optionalKey(Schema.Array(TaskId)),
});
export type HoustonTaskDomainSaveInput = typeof HoustonTaskDomainSaveInput.Type;

export const HoustonTaskSettingsGetInput = Schema.Struct({ projectId: ProjectId });
export type HoustonTaskSettingsGetInput = typeof HoustonTaskSettingsGetInput.Type;

export const HoustonTaskSettingsSetInput = Schema.Struct({
  projectId: ProjectId,
  settings: HoustonTaskSettingsInput,
});
export type HoustonTaskSettingsSetInput = typeof HoustonTaskSettingsSetInput.Type;

export const HoustonTaskImportInput = Schema.Struct({});
export type HoustonTaskImportInput = typeof HoustonTaskImportInput.Type;

export const HoustonTaskStartInput = Schema.Struct({
  id: HoustonTaskRef,
  /** Assigns an unassigned task to this project first. */
  projectId: Schema.optionalKey(ProjectId),
  /** The project's start model when absent. */
  modelSelection: Schema.optionalKey(ModelSelection),
  /** The project's current branch when absent. */
  baseRef: Schema.optionalKey(Schema.String),
  overrideReadiness: Schema.optionalKey(Schema.Boolean),
});
export type HoustonTaskStartInput = typeof HoustonTaskStartInput.Type;

/** `brief` is present only with `prefill` delivery, for the client to put in the composer. */
export const HoustonTaskStartResult = Schema.Struct({
  run: HoustonTaskRun,
  brief: Schema.optionalKey(Schema.String),
});
export type HoustonTaskStartResult = typeof HoustonTaskStartResult.Type;

export const HoustonTaskRunControlInput = Schema.Struct({
  runId: PositiveInt,
  action: Schema.Literals(["stop", "resume", "retry"]),
});
export type HoustonTaskRunControlInput = typeof HoustonTaskRunControlInput.Type;

export const HoustonTaskHandbackInput = Schema.Struct({
  id: HoustonTaskRef,
  summary: Schema.String,
});
export type HoustonTaskHandbackInput = typeof HoustonTaskHandbackInput.Type;

export const HoustonTaskPlanStartInput = Schema.Struct({
  id: HoustonTaskRef,
  expectedRevision: PositiveInt,
  modelSelection: ModelSelection,
});
export type HoustonTaskPlanStartInput = typeof HoustonTaskPlanStartInput.Type;

export const HoustonTaskPlanAnswerInput = Schema.Struct({
  id: HoustonTaskRef,
  expectedRevision: PositiveInt,
  question: Schema.String,
  answer: Schema.String,
});
export type HoustonTaskPlanAnswerInput = typeof HoustonTaskPlanAnswerInput.Type;

export const HoustonTaskPlanApproveInput = Schema.Struct({
  id: HoustonTaskRef,
  expectedRevision: PositiveInt,
  planRevision: PositiveInt,
});
export type HoustonTaskPlanApproveInput = typeof HoustonTaskPlanApproveInput.Type;

/** `runId` names the implementation run to review; the project's reviewer when no model is given. */
export const HoustonTaskReviewStartInput = Schema.Struct({
  runId: PositiveInt,
  modelSelection: Schema.optionalKey(ModelSelection),
});
export type HoustonTaskReviewStartInput = typeof HoustonTaskReviewStartInput.Type;

/** What the recorded planner submits; the server checks it is the recorded planner. */
export const HoustonTaskPlanSubmitInput = Schema.Struct({
  id: HoustonTaskRef,
  proposal: HoustonTaskPlanProposal,
});
export type HoustonTaskPlanSubmitInput = typeof HoustonTaskPlanSubmitInput.Type;

/** `findings` is checked field by field, so a refusal can name the wrong one. */
export const HoustonTaskReviewSubmitInput = Schema.Struct({
  runId: PositiveInt,
  verdict: Schema.Literals(["pass", "fail"]),
  findings: Schema.Array(Schema.Unknown),
});
export type HoustonTaskReviewSubmitInput = typeof HoustonTaskReviewSubmitInput.Type;
