import * as Schema from "effect/Schema";

import {
  CommandId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "../baseSchemas.ts";

/** Agent text is shown verbatim, so it is bounded before it reaches a card or a prompt. */
export const HOUSTON_PROJECT_REQUEST_REASON_MAX_LENGTH = 2_000;

const ProjectRequestReason = Schema.String.check(
  Schema.isMaxLength(HOUSTON_PROJECT_REQUEST_REASON_MAX_LENGTH),
);
const ProjectRequestPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

export const HoustonProjectRequestStatus = Schema.Literals([
  "pending",
  "adding",
  "added",
  "declined",
  "cancelled",
  "failed",
]);
export type HoustonProjectRequestStatus = typeof HoustonProjectRequestStatus.Type;

/**
 * An agent outside full access asked to add a project. The server resolves
 * the folder before showing the card, so the user approves one exact path.
 */
export const HoustonProjectRequestFields = {
  type: Schema.Literal("project_request"),
  title: TrimmedNonEmptyString,
  reason: ProjectRequestReason,
  workspaceRoot: ProjectRequestPath,
  /** A folder that does not exist yet will be created for this project. */
  createsFolder: Schema.Boolean,
  /** The folder is made into a new git repository with its first commit. */
  createsRepository: Schema.Boolean,
  projectRequestStatus: HoustonProjectRequestStatus,
  projectId: Schema.optional(ProjectId),
  failure: Schema.optional(Schema.String),
} as const;

export const HoustonProjectRequestRecordCommand = Schema.Struct({
  type: Schema.Literal("project_request.record"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: RunId,
  nodeId: NodeId,
  turnItemId: TurnItemId,
  title: TrimmedNonEmptyString,
  reason: ProjectRequestReason,
  workspaceRoot: ProjectRequestPath,
  createsFolder: Schema.Boolean,
  createsRepository: Schema.Boolean,
  projectRequestStatus: HoustonProjectRequestStatus,
  projectId: Schema.optional(ProjectId),
  failure: Schema.optional(Schema.String),
});

export const HoustonProjectRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("approve") }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type HoustonProjectRequestAnswerInput = typeof HoustonProjectRequestAnswerInput.Type;

const HOUSTON_PROJECT_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the add-project request.",
  not_found: "This add-project request no longer exists.",
  already_answered: "This add-project request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this project can't be added from here.",
  call_dropped:
    "The agent is no longer waiting for this answer, so the request was cancelled. Ask it to try again.",
  record_failed: "Could not record the add-project answer.",
} as const;

export const HoustonProjectRequestFailureReason = Schema.Literals(
  Object.keys(HOUSTON_PROJECT_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof HOUSTON_PROJECT_REQUEST_FAILURE_MESSAGES
  >,
);
export type HoustonProjectRequestFailureReason = typeof HoustonProjectRequestFailureReason.Type;

export class HoustonProjectRequestError extends Schema.TaggedError<HoustonProjectRequestError>()(
  "HoustonProjectRequestError",
  {
    reason: HoustonProjectRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return HOUSTON_PROJECT_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
