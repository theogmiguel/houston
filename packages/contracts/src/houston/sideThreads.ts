import * as Schema from "effect/Schema";

import { CommandId, MessageId, PositiveInt, ProjectId, RunId, ThreadId } from "../baseSchemas.ts";
import { ChatAttachment } from "../chatAttachment.ts";
import { ModelSelection } from "../modelSelection.ts";

/** A read-only thread: an aside or second opinion beside a source run, or a harness review. */
export const HoustonSideThread = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["aside", "secondOpinion"]),
    sourceThreadId: ThreadId,
    sourceRunId: RunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("harnessReview"),
    reviewId: PositiveInt,
  }),
]);
export type HoustonSideThread = typeof HoustonSideThread.Type;

/** The side threads that sit beside a source thread. */
export type HoustonSourcedSideThread = Extract<
  HoustonSideThread,
  { readonly sourceThreadId: ThreadId }
>;

export const hasSourceThread = (
  side: HoustonSideThread | undefined,
): side is HoustonSourcedSideThread => side !== undefined && side.kind !== "harnessReview";

/** Starts a harness review's thread; internal, so only the server sends it. */
export const HoustonHarnessReviewStartCommand = Schema.Struct({
  type: Schema.Literal("houston.harness-review.start"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  reviewId: PositiveInt,
  modelSelection: ModelSelection,
  messageId: MessageId,
  text: Schema.String,
});

/** The side-thread commands; `orchestrationV2.ts` passes its creation fields (no cycle). */
export const makeHoustonSideThreadCommands = <const CreationFields extends Schema.Struct.Fields>(
  creationFields: CreationFields,
) =>
  [
    Schema.Struct({
      type: Schema.Literal("houston.aside.start"),
      ...creationFields,
      commandId: CommandId,
      sourceThreadId: ThreadId,
      asideThreadId: ThreadId,
      messageId: MessageId,
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
    }),
    Schema.Struct({
      type: Schema.Literal("houston.second-opinion.request"),
      ...creationFields,
      commandId: CommandId,
      sourceThreadId: ThreadId,
      runId: RunId,
      reviewThreadId: ThreadId,
      modelSelection: ModelSelection,
    }),
    Schema.Struct({
      type: Schema.Literal("houston.side-thread.send"),
      commandId: CommandId,
      sideThreadId: ThreadId,
      runId: RunId,
    }),
  ] as const;
