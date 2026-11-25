import * as Schema from "effect/Schema";

/** What a provider turn's token usage adds for the context meter's compaction note. */
export const HoustonProviderTurnCompaction = Schema.Struct({
  /** False when the provider never compacts on its own; absent when it does or is not known. */
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
