/**
 * The composer draws model and effort as one split control: two triggers sharing a divider.
 * The footer owns the group element, so the two triggers only drop their standalone radius and
 * let the group decide where the divider sits. `SPLIT_DIVIDER_CLASS` is that divider.
 */
export const SPLIT_CONTROL_CLASS = "inline-flex min-w-0 items-center";

export const SPLIT_DIVIDER_CLASS = "mx-0.5 h-3 w-px shrink-0 bg-border";

/** Which half of the split control a trigger draws. */
export type TraitsSplitPart = "start" | "end";

export function traitsSplitTriggerClassName(part: TraitsSplitPart | undefined): string {
  if (part === "start") return "rounded-e-none";
  if (part === "end") return "rounded-s-none";
  return "";
}

const SHORT_EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimum: "Min",
  minimal: "Min",
  medium: "Med",
  "extra high": "Xhigh",
  extra: "Xhigh",
  xhigh: "Xhigh",
  maximum: "Max",
};

const NARROW_EFFORT_LABELS: Readonly<Record<string, string>> = {
  "extra high": "Xh",
  extra: "Xh",
  xhigh: "Xh",
};

/**
 * The segmented effort control fits five levels in 300px, so long catalog labels collapse to the
 * board's short forms: "Medium" reads "Med" and "Extra High" reads "Xhigh". The compact composer
 * row shortens "Xhigh" to "Xh" as the board's narrow pane does.
 */
export function shortEffortLabel(label: string, narrow = false): string {
  const trimmed = label.trim();
  const key = trimmed.toLowerCase();
  const mapped = narrow
    ? (NARROW_EFFORT_LABELS[key] ?? SHORT_EFFORT_LABELS[key])
    : SHORT_EFFORT_LABELS[key];
  return mapped ?? trimmed;
}
