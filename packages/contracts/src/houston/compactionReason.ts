import * as Schema from "effect/Schema";

/**
 * What woke a thread that Houston compacted before the waking turn started. Each value names the
 * source in the timeline's existing compaction row; it is not a new row.
 */
export const WAKE_COMPACTION_SOURCES = [
  "agentMessage",
  "delegatedResult",
  "limitResume",
  "backgroundCompletion",
  "restartNote",
  "manualContinuation",
  "userMessage",
  "pullRequestWatch",
  "cardAnswer",
  "childQuestionAnswer",
  "scheduledTask",
  "taskRun",
  "slackAnswer",
  "mergeQueueNote",
] as const;
export type WakeCompactionSource = (typeof WAKE_COMPACTION_SOURCES)[number];

export type WakeCompactionReason = `wake:${WakeCompactionSource}`;

const WAKE_REASON_PREFIX = "wake:";

export function isWakeCompactionReason(reason: string): reason is WakeCompactionReason {
  return reason.startsWith(WAKE_REASON_PREFIX);
}

/** The source a wake reason carries, or null for a reason that is not a wake. */
export function wakeCompactionSource(reason: string): WakeCompactionSource | null {
  if (!isWakeCompactionReason(reason)) return null;
  const source = reason.slice(WAKE_REASON_PREFIX.length);
  return (WAKE_COMPACTION_SOURCES as ReadonlyArray<string>).includes(source)
    ? (source as WakeCompactionSource)
    : null;
}

/**
 * Why Houston sent the compaction a thread's `/compact` message asks for. Providers report
 * their own trigger on the compaction boundary, so it is not a value here. A `wake:` value also
 * names what woke the thread, so the timeline can say which turn the compaction ran ahead of.
 */
export const OrchestrationV2CompactionReason = Schema.Literals([
  "beforeCacheExpires",
  "onReturn",
  "onRequest",
  "wake:agentMessage",
  "wake:delegatedResult",
  "wake:limitResume",
  "wake:backgroundCompletion",
  "wake:restartNote",
  "wake:manualContinuation",
  "wake:userMessage",
  "wake:pullRequestWatch",
  "wake:cardAnswer",
  "wake:childQuestionAnswer",
  "wake:scheduledTask",
  "wake:taskRun",
  "wake:slackAnswer",
  "wake:mergeQueueNote",
]);
export type OrchestrationV2CompactionReason = typeof OrchestrationV2CompactionReason.Type;
