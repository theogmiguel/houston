import {
  isCompactCommandText,
  isListedThreadLineage,
  type OrchestrationV2ThreadProjection,
} from "@houston-app/contracts";
import {
  CLAUDE_PROMPT_CACHE_TTL_1H_MS,
  COMPACTION_SUGGESTION_MIN_TOKENS,
} from "@houston-app/shared/claudeCompaction";
import { derivePendingBackgroundWork } from "@houston-app/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

// Claude Code's idleCompaction defaults to 200K and won't go below 100K. Below
// that a cold re-read is cheap, so compacting mostly loses context for little
// saving.
const MIN_CONTEXT_TOKENS = COMPACTION_SUGGESTION_MIN_TOKENS;
// Start this long before the cache expires: enough for the session to resume and send the
// compaction while the cache is still warm. Capped at half the lifetime, because an expiry derived
// from the response is later than the real one, measured from the request.
const MAX_LEAD_MS = 5 * 60_000;
// Resuming the session takes time, so a thread found with less than this share of its lead left
// before expiry would compact cold; it is skipped instead.
const MIN_TIME_LEFT_SHARE_OF_LEAD = 0.5;
// No cache Claude reports outlives this, so a run that completed earlier has an expired cache.
export const IDLE_COMPACTION_MAX_CACHE_TTL_MS = CLAUDE_PROMPT_CACHE_TTL_1H_MS;

export type IdleCompactionRecords = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "messages"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "turnItems"
  | "contextTransfers"
>;

/**
 * When an idle Claude thread should compact, or null. The window ends when its prompt cache
 * expires; compacting later pays a full uncached read. `latestPromptCacheTtlMs` is the latest
 * lifetime reported on the thread's provider thread.
 */
export function idleCompactionWindow(
  {
    thread,
    runs,
    messages,
    providerThreads,
    providerTurns,
    runtimeRequests,
    turnItems,
    contextTransfers,
  }: IdleCompactionRecords,
  nowMs: number,
  latestPromptCacheTtlMs?: number,
): {
  readonly runId: (typeof runs)[number]["id"];
  readonly startMs: number;
  readonly endMs: number;
} | null {
  if (thread.deletedAt !== null || thread.archivedAt !== null) return null;
  if (thread.settledAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
    return null;
  if (!isListedThreadLineage(thread.lineage)) return null;
  const latestRun = runs.reduce<(typeof runs)[number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  if (latestRun?.status !== "completed" || latestRun.completedAt === null) return null;
  const message = messages.find((candidate) => candidate.id === latestRun.userMessageId);
  // Never compact a compaction, so one idle spell compacts at most once.
  if (message === undefined || isCompactCommandText(message.text)) return null;
  if (
    runtimeRequests.some((request) => request.status === "pending") ||
    // A pending merge-back belongs to the user's next message.
    contextTransfers.some(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.targetThreadId === thread.id &&
        transfer.status === "pending",
    ) ||
    // Background work reports into the next turn; compaction would swallow it.
    derivePendingBackgroundWork({
      latestRun,
      runs,
      providerThreads,
      turnItems,
      activeProviderThreadId: thread.activeProviderThreadId,
    }).length > 0
  )
    return null;
  const providerThread = providerThreads.find(
    (candidate) => candidate.id === thread.activeProviderThreadId,
  );
  // The thread's current selection receives the /compact, so it must still be this Claude session.
  if (
    providerThread?.driver !== "claudeAgent" ||
    providerThread.id !== latestRun.providerThreadId ||
    providerThread.providerInstanceId !== thread.providerInstanceId ||
    latestRun.providerInstanceId !== thread.providerInstanceId
  )
    return null;
  const usages = providerTurns
    .filter((turn) => turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined)
    .map((turn) => turn.tokenUsage!)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const usage = usages[0];
  if (usage === undefined || usage.usedTokens < MIN_CONTEXT_TOKENS) return null;
  const expiresAtMs =
    usage.promptCacheExpiresAt === undefined ? undefined : Date.parse(usage.promptCacheExpiresAt);
  // A request served fully from cache reports no TTL but refreshes the cache with the lifetime
  // the session last reported. With none reported, any guess could be late: skip, never compact cold.
  const ttlMs =
    usage.promptCacheTtlMs ??
    latestPromptCacheTtlMs ??
    (expiresAtMs === undefined ? undefined : expiresAtMs - Date.parse(usage.updatedAt));
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  const endMs = expiresAtMs ?? Date.parse(usage.updatedAt) + ttlMs;
  const leadMs = Math.min(MAX_LEAD_MS, ttlMs / 2);
  if (!Number.isFinite(endMs) || endMs - nowMs < leadMs * MIN_TIME_LEFT_SHARE_OF_LEAD) return null;
  return { runId: latestRun.id, startMs: endMs - leadMs, endMs };
}
