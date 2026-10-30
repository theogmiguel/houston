// Asides and second opinions: read-only threads beside a source thread. The rules are pure
// functions here; the orchestrator applies them and emits upstream's events only.
import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { isForkableSourceRunStatus } from "../orchestration-v2/ThreadForkService.ts";

export const ASIDE_NEEDS_FINISHED_TURN = "An aside needs a finished turn in this thread.";
export const REVIEW_NEEDS_ANOTHER_PROVIDER =
  "A second opinion needs a different provider from the one that ran this turn.";
export const REVIEW_NEEDS_COMPLETED_TURN = "Only a completed turn can get a second opinion.";
export const SIDE_RESULT_ONLY_THROUGH_SEND =
  "A side thread's result enters its thread only through Send to thread.";
export const REVIEW_ALREADY_SENT = "This second opinion is already in the thread.";
export const ONLY_FINISHED_REVIEW_SENDS =
  "Only a finished second opinion can be sent to the thread.";
export const SIDE_THREAD_READ_ONLY = "A side thread is read-only.";
export const NO_DIFF_RECORDED = "No diff is recorded for this turn.";

// One turn must not fill a reviewer's context window; the diff gets most of the room.
export const REVIEW_REQUEST_LIMIT = 4_000;
export const REVIEW_REPORT_LIMIT = 8_000;
export const REVIEW_DIFF_LIMIT = 60_000;

/** `text` cut to `limit` characters, ending with a marker that says how much is shown. */
export function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[truncated: showing ${limit} of ${text.length} characters]`;
}

/** The first message of a second opinion: the reviewed run's request, report and diff. */
export function reviewPrompt(input: {
  readonly request: string;
  readonly report: string;
  readonly diff: string | null;
}): string {
  return [
    "Review one turn another agent completed in this workspace. Do not change any files: read what you need, then report problems, risks and anything the turn missed, most important first.",
    "## The user's request",
    boundText(input.request, REVIEW_REQUEST_LIMIT),
    "## The agent's final report",
    boundText(input.report, REVIEW_REPORT_LIMIT),
    "## The turn's diff",
    input.diff === null ? NO_DIFF_RECORDED : boundText(input.diff, REVIEW_DIFF_LIMIT),
  ].join("\n\n");
}

/** The run an aside forks from: the latest run in a finished status. */
export function asideSourceRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  return runs
    .filter((run) => isForkableSourceRunStatus(run.status))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

/** The last assistant text a run ended with, as stored, or undefined when it has none. */
export function finalAssistantText(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: RunId,
): string | undefined {
  return turnItems
    .filter(
      (item): item is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
        item.runId === runId && item.type === "assistant_message" && item.text.trim().length > 0,
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0]?.text;
}

/** The id a sent review takes in its source, so one review enters the thread once. */
export const sideMessageId = (runId: RunId) => MessageId.make(`side-${runId}`);

export function sentReviewText(input: {
  readonly provider: string;
  readonly ordinal: number;
  readonly review: string;
}): string {
  return `Second opinion from ${input.provider} on turn ${input.ordinal}:\n\n${input.review}`;
}

export const isSideThread = (thread: Pick<OrchestrationV2AppThread, "side">) =>
  thread.side !== undefined;

export const hasReadOnlyRun = (capabilities: OrchestrationV2ProviderCapabilities) =>
  capabilities.runtimePolicy.readOnlyRun !== undefined;

/** A side thread's policy: read-only whatever its stored modes; `plan` would open a write path. */
export function readOnlyPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): ProviderAdapter.ProviderAdapterV2RuntimePolicy {
  return {
    ...policy,
    interactionMode: "default",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
  };
}
