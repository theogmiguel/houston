import type { PaneDensity } from "../../grid/density";

interface DensityTimelineEntry {
  readonly kind: string;
  readonly message?: { readonly role: string } | undefined;
}

/**
 * The rows a pane keeps at a given density. Compact starts at the latest user
 * turn; glance keeps only the latest assistant message. The thread's present
 * comes from the footer line, so a glance pane still says what is happening.
 */
export function trimTimelineForDensity<T extends DensityTimelineEntry>(
  entries: readonly T[],
  density: PaneDensity,
): readonly T[] {
  if (density === "solo" || density === "comfortable") return entries;
  const role = density === "glance" ? "assistant" : "user";
  const start = entries.findLastIndex(
    (entry) => entry.kind === "message" && entry.message?.role === role,
  );
  if (start >= 0) return entries.slice(start);
  return density === "glance" ? entries.slice(-1) : entries.slice(-3);
}
