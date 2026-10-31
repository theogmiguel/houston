// Houston's Slack tools for the agent working on a Slack-filed task: one question at a time in
// the request's thread, and the hand-back the requester and the owner read.
import { OrchestratorMcpFailure, PositiveInt } from "@t3tools/contracts";
import { HOUSTON_SLACK_LIMITS, HoustonSlackError } from "@t3tools/contracts/houston/slack";
import { HoustonTask, HoustonTaskError } from "@t3tools/contracts/houston/tasks";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { HoustonSlackConversation } from "../Conversation.ts";

const L = HOUSTON_SLACK_LIMITS;

const shared = {
  failure: Schema.Union([HoustonSlackError, HoustonTaskError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HoustonSlackConversation,
  ],
};

// Bounds are checked by the handler, so a refusal names the field, the limit and the length.
const lines = (description: string) =>
  Schema.optional(Schema.Array(Schema.String).annotate({ description }));

const AskTool = Tool.make("houston_slack_ask", {
  ...shared,
  description: `Ask the requester one question in the Slack thread of the request you are working on; the answer arrives as your next message. ${L.optionsMin} to ${L.optionsMax} options; only one question at a time.`,
  parameters: Schema.Struct({
    context: Schema.String.annotate({
      description: `What the requester needs to know first, at most ${L.questionContextChars} characters.`,
    }),
    question: Schema.String.annotate({
      description: `At most ${L.questionChars} characters.`,
    }),
    options: Schema.Array(Schema.String).annotate({
      description: `${L.optionsMin} to ${L.optionsMax} answers, each at most ${L.optionChars} characters.`,
    }),
    recommended: Schema.Int.annotate({ description: "The index of the option you recommend." }),
    why: Schema.optional(
      Schema.String.annotate({
        description: `Why you recommend it, at most ${L.whyChars} characters.`,
      }),
    ),
  }),
  success: Schema.Struct({ questionId: PositiveInt }),
}).annotate(Tool.Destructive, false);

const HandbackTool = Tool.make("houston_slack_handback", {
  ...shared,
  description:
    "Hand the Slack request's task back for review. The requester reads subject, changes, steps and caveats in the thread; notes, warnings and blockers go to the owner only. `refused`: the request cannot go ahead, and `changes` says why.",
  parameters: Schema.Struct({
    outcome: Schema.Literals(["ready", "refused"]),
    subject: Schema.String.annotate({ description: `At most ${L.subjectChars} characters.` }),
    changes: Schema.String.annotate({
      description: `What changes for the requester, in their words, at most ${L.changesChars} characters.`,
    }),
    steps: lines(`How to see the change once it is live: at most ${L.steps} of ${L.stepChars}.`),
    caveats: Schema.optional(
      Schema.String.annotate({ description: `At most ${L.caveatsChars} characters.` }),
    ),
    liveNote: Schema.optional(
      Schema.String.annotate({
        description: `Posted when the task is done, at most ${L.noteChars} characters.`,
      }),
    ),
    droppedNote: Schema.optional(
      Schema.String.annotate({
        description: `Posted when the task is canceled, at most ${L.noteChars} characters.`,
      }),
    ),
    size: Schema.optional(
      Schema.Literals(["small", "medium", "large"]).annotate({
        description: "Your size call; small is yours to make, otherwise the diff decides.",
      }),
    ),
    notes: lines(`Facts for the owner: at most ${L.ownerLines} of ${L.ownerLineChars}.`),
    warnings: lines(`Warnings for the owner: at most ${L.ownerLines} of ${L.ownerLineChars}.`),
    blockers: lines(`What must be fixed before merging: at most ${L.ownerLines}.`),
  }),
  success: HoustonTask,
}).annotate(Tool.Destructive, false);

export const HoustonSlackToolkit = Toolkit.make(AskTool, HandbackTool);
