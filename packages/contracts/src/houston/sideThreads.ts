import * as Schema from "effect/Schema";

import { CommandId, MessageId, RunId, ThreadId } from "../baseSchemas.ts";
import { ChatAttachment } from "../chatAttachment.ts";
import { ModelSelection } from "../modelSelection.ts";

/** A read-only thread beside `sourceThreadId`: an aside about, or a review of, `sourceRunId`. */
export const HoustonSideThread = Schema.Struct({
  kind: Schema.Literals(["aside", "secondOpinion"]),
  sourceThreadId: ThreadId,
  sourceRunId: RunId,
});
export type HoustonSideThread = typeof HoustonSideThread.Type;

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
