/** Divider snapping and labels for the grid's resize handles. */

/** The widths the handle snaps to, as the first cell's share of its pair. */
export const SPLIT_PRESETS = [1 / 3, 1 / 2, 2 / 3] as const;

const FRACTION_LABELS = new Map<number, string>([
  [1 / 3, "⅓"],
  [1 / 2, "½"],
  [2 / 3, "⅔"],
]);

export function splitFractionLabel(value: number, snapped: number | null): string {
  if (snapped !== null) return FRACTION_LABELS.get(snapped) ?? `${Math.round(value * 100)}%`;
  return `${Math.round(value * 100)}%`;
}

/**
 * Snaps `raw` (the first cell's share) to the nearest preset within
 * `SNAP_DISTANCE_PX` of pointer travel. 12px feels magnetic without trapping
 * the drag between presets.
 */
export function snapSplitRatio(
  raw: number,
  pairPx: number,
  snapDistancePx: number,
): { value: number; snapped: number | null } {
  if (pairPx <= 0) return { value: raw, snapped: null };
  for (const preset of SPLIT_PRESETS) {
    if (Math.abs(raw - preset) * pairPx <= snapDistancePx) {
      return { value: preset, snapped: preset };
    }
  }
  return { value: raw, snapped: null };
}

/** The next preset past `value` in `direction`, for keyboard resizing. */
export function stepSplitPreset(value: number, direction: 1 | -1): number {
  if (direction === 1) {
    return SPLIT_PRESETS.find((preset) => preset > value + 1e-3) ?? value;
  }
  return SPLIT_PRESETS.findLast((preset) => preset < value - 1e-3) ?? value;
}

/** True when `value` is one of the presets, within the keyboard's step tolerance. */
export function presetOf(value: number): number | null {
  return SPLIT_PRESETS.find((preset) => Math.abs(preset - value) <= 1e-3) ?? null;
}
