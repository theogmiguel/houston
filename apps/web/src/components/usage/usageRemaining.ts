/**
 * Plan-limit meters carry no warning colour: amber means "Needs you", so a
 * bar fills with t2, its number stays t2 until 20% is left, then the number
 * takes full contrast, and only an exhausted bar takes the stop colour.
 */
export type UsageRemainingTone = "normal" | "low" | "empty";

export const LOW_REMAINING_PERCENT = 20;

export function usageRemainingTone(remaining: number): UsageRemainingTone {
  const clamped = Math.max(0, Math.min(100, remaining));
  if (clamped <= 0) return "empty";
  if (clamped < LOW_REMAINING_PERCENT) return "low";
  return "normal";
}

/** The bar's fill: t2 in every live window, stop only at zero. */
export function usageRemainingFill(remaining: number): string {
  return usageRemainingTone(remaining) === "empty" ? "var(--stop)" : "var(--secondary-foreground)";
}
