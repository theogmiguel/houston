// How an answer reaches a Slack run's thread: one queued user message through the
// `houston.slack.answer` command (AD-066). One command id per question, so a resend replays.
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";

export interface RunMessage {
  readonly threadId: string;
  readonly questionId: number;
  /** The fenced answer. */
  readonly text: string;
}

export class HoustonSlackRunMessages extends Context.Service<
  HoustonSlackRunMessages,
  { readonly deliver: (message: RunMessage) => Effect.Effect<void, string> }
>()("houston/houston/slack/RunMessages/HoustonSlackRunMessages") {}

export const layer = Layer.effect(
  HoustonSlackRunMessages,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const deliver = Effect.fn("HoustonSlackRunMessages.deliver")((message: RunMessage) =>
      orchestrator
        .dispatch({
          type: "houston.slack.answer",
          commandId: CommandId.make(`houston-slack-answer:${message.questionId}`),
          threadId: ThreadId.make(message.threadId),
          questionId: message.questionId,
          text: message.text,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (error) =>
              userFacingDispatchErrorMessage(error) ?? `the answer was refused: ${error._tag}`,
          ),
        ),
    );
    return HoustonSlackRunMessages.of({ deliver });
  }),
);
