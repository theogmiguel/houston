// Asides and second opinions: read-only threads beside a source thread. The rules are pure
// functions here; the orchestrator applies them and emits upstream's events only.
import {
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
export const asideWaitsForTurn = (provider: string) =>
  `${provider} cannot fork a thread while its turn runs, so an aside has to wait for this turn to finish.`;

// OpenCode 1 forkThread and OpenCode 2 ensureQuiet refuse a session with a turn in progress.
const FORKS_ONLY_IDLE_SESSIONS: ReadonlySet<string> = new Set(["opencode"]);
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/** The refusal for an aside whose source's provider cannot fork it now, or undefined. */
export function asideForkRefusal(
  driver: ProviderDriverKind,
  runs: ReadonlyArray<OrchestrationV2Run>,
): string | undefined {
  if (!FORKS_ONLY_IDLE_SESSIONS.has(driver)) return undefined;
  if (!runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return undefined;
  return asideWaitsForTurn(PROVIDER_DISPLAY_NAMES[driver] ?? driver);
}

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

/** Whether a thread may hold T3 MCP tools; a thread that cannot be read gets none. */
export const mayHoldT3Tools = <E, R>(
  thread: Effect.Effect<Pick<OrchestrationV2AppThread, "side">, E, R>,
) =>
  thread.pipe(
    Effect.map((read) => !isSideThread(read)),
    Effect.orElseSucceed(() => false),
  );

/** Threads other than side threads that must run read-only: Tasks' planners and reviewers.
 * It has no default, so an assembly that leaves it out fails to build instead of running every
 * planner and reviewer with write access. */
export class HoustonReadOnlyThreads extends Context.Service<
  HoustonReadOnlyThreads,
  {
    readonly isReadOnly: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** The submit tool of the thread's role, or undefined when it has none or the read fails. */
    readonly submitToolOf: (threadId: ThreadId) => Effect.Effect<HoustonTaskSubmitTool | undefined>;
  }
>()("houston/houston/sideThreads/HoustonReadOnlyThreads") {}

export type HoustonTaskSubmitTool = NonNullable<
  ProviderAdapter.ProviderAdapterV2RuntimePolicy["houstonTaskSubmitTool"]
>;

/** For assemblies without Tasks, such as upstream's tests: no thread is a planner or reviewer. */
export const layerNoReadOnlyThreads = Layer.succeed(HoustonReadOnlyThreads, {
  isReadOnly: Effect.fn("HoustonReadOnlyThreads.none")(() => Effect.succeed(false)),
  submitToolOf: Effect.fn("HoustonReadOnlyThreads.noTool")(() =>
    // @effect-diagnostics-next-line effectSucceedWithVoid:off - the shape returns undefined, not void.
    Effect.succeed(undefined),
  ),
});

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
