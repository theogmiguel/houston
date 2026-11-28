import {
  isCompactCommandText,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Notification,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type RunStartOrigin,
  type WakeCompactionReason,
  type WakeCompactionSource,
} from "@houston-app/contracts";
import type { IdleCompactionMode } from "@houston-app/contracts/settings";
import type { ProviderInstanceId } from "@houston-app/contracts";
import { COMPACTION_SUGGESTION_MIN_TOKENS } from "@houston-app/shared/claudeCompaction";

// The composer's own stale check assumes a session that cached for this long when the provider
// reports no lifetime. A request served entirely from cache reports none either.
const RESUME_COMPACTION_FALLBACK_MS = 70 * 60_000;

export interface StaleWakeRecords {
  readonly thread: OrchestrationV2AppThread;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

/** What is about to wake the thread; the fields each producer sets on its dispatch. */
export interface StaleWakeTrigger {
  readonly origin: RunStartOrigin;
  readonly messageId: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
  readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
  readonly commandId?: string | undefined;
  readonly notification?: Pick<OrchestrationV2Notification, "source"> | undefined;
  readonly delegatedCompletion?: unknown;
  readonly scheduledTaskId?: unknown;
  readonly senderThreadId?: unknown;
  readonly restartContinuationOfRunId?: unknown;
  readonly usageLimitContinuationOfRunId?: unknown;
  readonly manualContinuationOfRunId?: unknown;
  readonly freshContext?: boolean | undefined;
  /** A turn the provider already started, a steer, or a restart of an active run. */
  readonly startsInProviderOrActiveTurn?: boolean | undefined;
}

export interface StaleWakeOneShot {
  readonly source: WakeCompactionSource;
  readonly reason: WakeCompactionReason;
  readonly usedTokens: number;
  /** Claude's own auto-compact point, or the minimum Houston uses when it has none. */
  readonly thresholdTokens: number;
  readonly idleMs: number;
}

const SOURCE_BY_MESSAGE_PREFIX: ReadonlyArray<readonly [string, WakeCompactionSource]> = [
  ["slack-answer-", "slackAnswer"],
  ["task-review-", "taskRun"],
];

function sourceFromId(
  commandId: string | undefined,
  messageId: string,
): WakeCompactionSource | null {
  if (commandId?.startsWith("houston-task") === true) return "taskRun";
  if (commandId?.startsWith("houston-merge-queue:") === true) return "mergeQueueNote";
  for (const [prefix, source] of SOURCE_BY_MESSAGE_PREFIX) {
    if (messageId.startsWith(prefix)) return source;
  }
  return null;
}

/** What woke a thread, for the compaction row. Null when the waking prompt is itself a compaction. */
export function wakeCompactionSourceFor(
  trigger: Pick<
    StaleWakeTrigger,
    | "messageId"
    | "text"
    | "attachments"
    | "createdBy"
    | "creationSource"
    | "commandId"
    | "notification"
    | "delegatedCompletion"
    | "scheduledTaskId"
    | "restartContinuationOfRunId"
    | "usageLimitContinuationOfRunId"
    | "manualContinuationOfRunId"
  >,
): WakeCompactionSource | null {
  if (trigger.attachments.length === 0 && isCompactCommandText(trigger.text)) return null;
  if (trigger.delegatedCompletion !== undefined) return "delegatedResult";
  if (trigger.restartContinuationOfRunId !== undefined) return "restartNote";
  if (trigger.usageLimitContinuationOfRunId !== undefined) return "limitResume";
  if (trigger.manualContinuationOfRunId !== undefined) return "manualContinuation";
  if (trigger.scheduledTaskId !== undefined) return "scheduledTask";
  const byId = sourceFromId(trigger.commandId, trigger.messageId);
  if (byId !== null) return byId;
  const kind = trigger.notification?.source.kind;
  if (kind === "delegated_task") return "childQuestionAnswer";
  if (kind === "monitor") return "pullRequestWatch";
  if (kind === "background_task" || kind === "subagent" || kind === "command")
    return "backgroundCompletion";
  if (trigger.createdBy === "agent") return "agentMessage";
  if (trigger.createdBy === "user" && trigger.creationSource === "server") return "cardAnswer";
  if (trigger.createdBy === "user") return "userMessage";
  return null;
}

function latestTurnUsage(
  projection: Pick<StaleWakeRecords, "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) {
  return projection.providerTurns
    .filter((turn) => turn.providerThreadId === providerThreadId && turn.tokenUsage !== undefined)
    .toSorted(
      (left, right) =>
        Date.parse(right.tokenUsage!.updatedAt) - Date.parse(left.tokenUsage!.updatedAt),
    )[0];
}

function cacheExpired(input: {
  readonly nowMs: number;
  readonly updatedAt: string;
  readonly promptCacheTtlMs?: number | undefined;
  readonly promptCacheExpiresAt?: string | undefined;
}): boolean {
  const expiresAtMs =
    input.promptCacheExpiresAt === undefined ? undefined : Date.parse(input.promptCacheExpiresAt);
  if (expiresAtMs !== undefined && Number.isFinite(expiresAtMs)) return input.nowMs >= expiresAtMs;
  const updatedAtMs = Date.parse(input.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  return input.nowMs - updatedAtMs >= (input.promptCacheTtlMs ?? RESUME_COMPACTION_FALLBACK_MS);
}

/**
 * A Claude thread that is over Claude's own auto-compact point with an expired prompt cache.
 * `null` for a warm or small thread, another provider, a side or native sub-agent thread, a
 * compaction, and a turn that already started or is exempt by name.
 */
export function staleWakeOneShot(input: {
  readonly projection: StaleWakeRecords;
  readonly providerInstanceId: ProviderInstanceId;
  readonly trigger: StaleWakeTrigger;
  readonly nowMs: number;
  readonly compactStaleThreadsOnWake: boolean;
  readonly idleCompaction: IdleCompactionMode;
}): StaleWakeOneShot | null {
  if (!input.compactStaleThreadsOnWake || input.idleCompaction === "off") return null;
  const { thread, messages, runs, providerThreads } = input.projection;
  if (input.trigger.origin === "provider" || input.trigger.origin === "maintenance") return null;
  if (input.trigger.freshContext === true || input.trigger.startsInProviderOrActiveTurn === true)
    return null;
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  const source = wakeCompactionSourceFor(input.trigger);
  if (source === null) return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.providerInstanceId !== input.providerInstanceId
  )
    return null;
  // A queued or preparing waking run may already be the newest one; the context it joins is the
  // latest completed turn's.
  const latestRun = runs
    .filter((run) => run.status === "completed" && run.completedAt !== null)
    .reduce<(typeof runs)[number] | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    );
  if (latestRun === null) return null;
  if (latestRun.providerThreadId !== providerThread.id) return null;
  const latestMessage = messages.find((message) => message.id === latestRun.userMessageId);
  if (latestMessage === undefined || isCompactCommandText(latestMessage.text)) return null;
  const usage = latestTurnUsage(input.projection, providerThread.id)?.tokenUsage;
  if (usage === undefined) return null;
  const thresholdTokens = usage.autoCompactThreshold ?? COMPACTION_SUGGESTION_MIN_TOKENS;
  if (usage.usedTokens < thresholdTokens) return null;
  if (
    !cacheExpired({
      nowMs: input.nowMs,
      updatedAt: usage.updatedAt,
      promptCacheTtlMs: usage.promptCacheTtlMs,
      promptCacheExpiresAt: usage.promptCacheExpiresAt,
    })
  )
    return null;
  const updatedAtMs = Date.parse(usage.updatedAt);
  return {
    source,
    reason: `wake:${source}`,
    usedTokens: usage.usedTokens,
    thresholdTokens,
    idleMs: Number.isFinite(updatedAtMs) ? Math.max(0, input.nowMs - updatedAtMs) : 0,
  };
}

/** The idempotent id of the one compaction a waking message may create. */
export function staleWakeCompactionMessageId(triggerMessageId: string): string {
  return `stale-compaction:${triggerMessageId}`;
}

export function staleWakeCompactionCommandId(triggerMessageId: string): string {
  return `command:stale-compaction:${triggerMessageId}`;
}

/** One line for logs and diagnostics, naming the thread, source and sizes. */
export function describeStaleWakeOneShot(oneShot: StaleWakeOneShot): string {
  return `Compacting a stale ${oneShot.source} wake at ${oneShot.usedTokens} tokens (cap ${oneShot.thresholdTokens}) after ${Math.round(oneShot.idleMs / 60_000)} min idle`;
}
