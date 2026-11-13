/**
 * Which tabs the strip keeps drawn. A chat is expensive, so the strip reports for each tab whether
 * it is near the camera (render it), kept (keep it rendered) or retained (keep its pane's body
 * mounted though it is off screen); the host decides what a chat does with that.
 */
import type { LayoutPaneSlot } from "./layoutModel";

/** In the overview a tab draws its content once its pane is at least this wide on screen. */
export const OVERVIEW_RENDER_MIN_PX = 120;
/**
 * Besides the tabs near the camera and the focused one, this many of the most recently near stay
 * rendered; the rest are released. Each rendered chat holds a timeline's DOM and memory, and every
 * focus move re-renders them.
 */
export const RENDERED_RECENT_CHATS = 8;

export interface NearRow {
  readonly slots: readonly LayoutPaneSlot[];
  /** The row's strip width in px. */
  readonly rowPx: number;
  /** The row's scroll in px. */
  readonly camera: number;
}

/** The tabs of panes within a window of the camera, on either side: a strip of a hundred columns draws the few near. */
export function nearTabIdsOnStrip(rows: readonly NearRow[], windowPx: number): Set<string> {
  const near = new Set<string>();
  for (const { slots, rowPx, camera } of rows) {
    for (const slot of slots) {
      if (slot.activeTabId === null) continue;
      const left = slot.rect.left * rowPx;
      const right = left + slot.rect.width * rowPx;
      if (right < camera - windowPx || left > camera + 2 * windowPx) continue;
      near.add(slot.activeTabId);
    }
  }
  return near;
}

/** Zoomed out, every pane is on screen; those too small to read stay a stand-in. */
export function nearTabIdsInOverview(
  rows: readonly { readonly slots: readonly LayoutPaneSlot[]; readonly stripWidth: number }[],
  windowPx: number,
  scale: number,
): Set<string> {
  const near = new Set<string>();
  for (const row of rows) {
    for (const slot of row.slots) {
      if (slot.activeTabId === null) continue;
      if (slot.rect.width * row.stripWidth * windowPx * scale >= OVERVIEW_RENDER_MIN_PX) {
        near.add(slot.activeTabId);
      }
    }
  }
  return near;
}

/** The tabs near the camera, most recently first, then earlier ones that still exist. */
export function nextRecentTabIds(
  near: ReadonlySet<string>,
  previous: readonly string[],
  exists: (tabId: string) => boolean,
): readonly string[] {
  return [...[...near].filter(exists), ...previous.filter((id) => exists(id) && !near.has(id))];
}

/** Near, focused or related tabs, and the most recent few that have left, stay rendered. */
export function keptTabIds(
  near: ReadonlySet<string>,
  recent: readonly string[],
  focusedTabId: string | null,
  relatedTabId: string | null,
): ReadonlySet<string> {
  const kept = new Set(near);
  if (focusedTabId !== null) kept.add(focusedTabId);
  if (relatedTabId !== null) kept.add(relatedTabId);
  let outside = 0;
  for (const id of recent) {
    if (outside >= RENDERED_RECENT_CHATS) break;
    if (kept.has(id)) continue;
    kept.add(id);
    outside += 1;
  }
  return kept;
}

/**
 * The tabs whose body stays mounted: those on screen, then those that were and are hidden now (a
 * workspace switch, another tab of the pane) until they close, so their drafts, scroll and
 * terminals survive.
 */
export function nextRetainedTabIds(
  visible: readonly string[],
  previous: readonly string[],
  exists: (tabId: string) => boolean,
): readonly string[] {
  const shown = new Set(visible);
  return [...visible, ...previous.filter((id) => exists(id) && !shown.has(id))];
}
