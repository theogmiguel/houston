import type { LayoutColumn, LayoutPaneSlot } from "./layoutModel";

/**
 * A pane counts as on screen (its thread highlights in the sidebar, and focus stays with it) when
 * at least this share of its width is inside the window; a column peeking at the edge does not.
 */
export const ON_SCREEN_MIN_SHARE = 0.5;

/** The share of the strip, from 0 to 1, that `slot` shows between `viewStart` and `viewEnd`. */
function widthInside(slot: LayoutPaneSlot, viewStart: number, viewEnd: number): number {
  return Math.min(slot.rect.left + slot.rect.width, viewEnd) - Math.max(slot.rect.left, viewStart);
}

/** The panes show their active tab; those at least half in view are on screen. */
export function tabIdsOnScreen(
  slots: readonly LayoutPaneSlot[],
  viewStart: number,
  viewEnd: number,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const slot of slots) {
    if (slot.activeTabId === null) continue;
    if (widthInside(slot, viewStart, viewEnd) >= slot.rect.width * ON_SCREEN_MIN_SHARE) {
      ids.add(slot.activeTabId);
    }
  }
  return ids;
}

/**
 * Focus follows the view: once the focused pane has less than half of itself (or of the window,
 * if it is wider) on screen, the column most in view takes focus, with the pane it last focused, or
 * the one at the focused pane's height. Returns that pane's id, or null to leave focus alone.
 */
export function paneToFollow(
  columns: readonly LayoutColumn[],
  focusedPaneId: string | null,
  slots: readonly LayoutPaneSlot[],
  viewStart: number,
  viewEnd: number,
  lastFocusedByColumn: ReadonlyMap<string, string>,
): string | null {
  if (focusedPaneId === null) return null;
  const slotByPane = new Map(slots.map((slot) => [slot.paneId, slot]));
  const focused = slotByPane.get(focusedPaneId);
  if (!focused) return null;
  const needed = Math.min(focused.rect.width, viewEnd - viewStart) * ON_SCREEN_MIN_SHARE;
  if (widthInside(focused, viewStart, viewEnd) >= needed) return null;
  let best: LayoutColumn | null = null;
  let bestInside = 0;
  for (const column of columns) {
    const slot = column.panes[0] ? slotByPane.get(column.panes[0].id) : undefined;
    const inside = slot ? widthInside(slot, viewStart, viewEnd) : 0;
    if (inside > bestInside) {
      best = column;
      bestInside = inside;
    }
  }
  if (!best || best.panes.length === 0) return null;
  const remembered = lastFocusedByColumn.get(best.id);
  const from = columns.find((column) => column.panes.some((pane) => pane.id === focusedPaneId));
  const index = from?.panes.findIndex((pane) => pane.id === focusedPaneId) ?? 0;
  const pane =
    best.panes.find((candidate) => candidate.id === remembered) ??
    best.panes[Math.min(Math.max(index, 0), best.panes.length - 1)]!;
  return pane.id;
}
