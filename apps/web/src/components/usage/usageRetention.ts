import { effectiveUsageRetentionDays, type UsageRetentionDays } from "@houston-app/contracts";

/** True when applying `next` deletes saved records one or more selected machines still keep. */
export function usageRetentionShortens(
  current: readonly UsageRetentionDays[],
  next: UsageRetentionDays,
): boolean {
  const nextDays = effectiveUsageRetentionDays(next);
  return current.some((value) => effectiveUsageRetentionDays(value) > nextDays);
}
