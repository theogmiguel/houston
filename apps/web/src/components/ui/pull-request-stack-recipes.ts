/** Visual recipes for a folded native pull request stack. Feature code composes these with layout utilities. */
export const STACK_SUMMARY_BUTTON = "text-left transition-colors";
export const STACK_SUMMARY_BUTTON_OPEN = "bg-hover/40";
export const STACK_SUMMARY_BUTTON_IDLE = "hover:bg-hover/60";
export const STACK_EXPANDED_FRAME = "rounded-lg bg-hover/20";
export const STACK_CHAIN_ARROW = "text-muted-foreground/70";
export const STACK_LAYER_NUMBER_WORST = "text-foreground";
export const STACK_CHEVRON = "text-muted-foreground transition-transform";
export const STACK_CHEVRON_OPEN = "rotate-180";
export const STACK_CHEVRON_FOLDED = "opacity-0 group-hover/pr-row:opacity-100";
export const STACK_DOT = "rounded-full";
export const STACK_DIFF_STAT = "font-mono";
export const STACK_BRANCH = "font-mono text-muted-foreground";
export const STACK_LAYERS_COUNT = "text-muted-foreground";
export const STACK_TONE_WARNING = "text-warning-foreground";
export const STACK_TONE_DRAFT = "text-muted-foreground";
export const STACK_TONE_READY = "text-success-foreground";
export const STACK_CHECKS_UNAVAILABLE = "text-2xs text-muted-foreground";

const DOT_BY_TONE = {
  merged: "bg-merged-foreground",
  closed: "bg-muted-foreground",
  draft: "border-[1.5px] border-muted-foreground bg-card",
  failing: "bg-destructive",
  pending: "bg-warning",
  ready: "bg-success",
} as const;

export function stackLayerDotClass(tone: keyof typeof DOT_BY_TONE): string {
  return DOT_BY_TONE[tone];
}
