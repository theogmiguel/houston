import * as Schema from "effect/Schema";

/**
 * Why Houston sent the compaction a thread's `/compact` message asks for. Providers report
 * their own trigger on the compaction boundary, so it is not a value here.
 */
export const OrchestrationV2CompactionReason = Schema.Literals([
  "beforeCacheExpires",
  "onReturn",
  "onRequest",
]);
export type OrchestrationV2CompactionReason = typeof OrchestrationV2CompactionReason.Type;
