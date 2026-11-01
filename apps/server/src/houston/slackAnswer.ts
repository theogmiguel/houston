// A Slack answer to a run's thread (AD-066): one queued user message per question, which waits
// behind an active run and starts a turn on an idle thread. The orchestrator applies it.
import type { MessageId, OrchestrationV2Command, OrchestrationV2Run } from "@t3tools/contracts";

export const SLACK_ANSWER_ALREADY_SENT = "This Slack answer is already in the thread.";
export const SLACK_ANSWER_NEEDS_LIVE_THREAD =
  "A Slack answer goes only to a thread that is not archived.";

export const slackAnswerMessageId = (questionId: number) =>
  `slack-answer-${questionId}` as MessageId;

const ACTIVE: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** Queued behind an active run, never steering or interrupting it; started on an idle thread. */
export const answerDispatchMode = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>["dispatchMode"] =>
  runs.some((run) => ACTIVE.has(run.status))
    ? { type: "queue_after_active" }
    : { type: "start_immediately" };
