import type { CSSProperties } from "react";

import {
  selectLayoutPaneSlots,
  type LayoutPaneSlot,
  type LayoutViewport,
  type LayoutWorkspace,
} from "./layoutModel";

/** Neighboring panes share an 8px gutter, independent of the window inset: each side gives 4px. */
export const HALF_PANE_GAP = "4px";

export const FULL_RECT = { left: 0, top: 0, width: 1, height: 1 } as const;

/** One workspace in the stack a workspace switch moves (see motion/workspaceSwitch.ts). */
export interface StackRow {
  id: string;
  workspace: LayoutWorkspace | null;
  /** Rows below the first, counted in windows. */
  offset: number;
  slots: LayoutPaneSlot[];
  /** The row's strip, in windows wide. */
  stripWidth: number;
  /** The row's horizontal scroll, in px. */
  camera: number;
}

/**
 * Pane edges land on whole pixels, so borders and text stay crisp at any split. Both panes round
 * the same boundary, so the gap between them stays exact. With `stripPx`, widths are measured in
 * pixels of a strip longer than the window.
 */
export function slotStyle(slot: LayoutPaneSlot, stripPx?: number): CSSProperties {
  const edge = (has: boolean) => (has ? HALF_PANE_GAP : "0px");
  const at = (fraction: number, offset: string) =>
    `round(calc(${fraction * 100}% + ${offset}), 1px)`;
  const across = (fraction: number, offset: string) =>
    stripPx === undefined
      ? at(fraction, offset)
      : `round(calc(${fraction * stripPx}px + ${offset}), 1px)`;
  const left = across(slot.rect.left, edge(slot.hasLeft));
  const right = across(slot.rect.left + slot.rect.width, `-1 * ${edge(slot.hasRight)}`);
  const top = at(slot.rect.top, edge(slot.hasAbove));
  const bottom = at(slot.rect.top + slot.rect.height, `-1 * ${edge(slot.hasBelow)}`);
  return { left, top, width: `calc(${right} - ${left})`, height: `calc(${bottom} - ${top})` };
}

/**
 * `slotStyle` for a pane in a stacked row: the stage is one window wide, the row sits `offset`
 * rows (and `gap`s) down and shifts left by its camera.
 */
export function stackSlotStyle(row: StackRow, slot: LayoutPaneSlot, gap: number): CSSProperties {
  const edge = (has: boolean) => (has ? HALF_PANE_GAP : "0px");
  const across = (fraction: number, offset: string) =>
    `round(calc(${fraction * row.stripWidth * 100}% - ${row.camera}px + ${offset}), 1px)`;
  const down = (fraction: number, offset: string) =>
    `round(calc(${(row.offset + fraction) * 100}% + ${row.offset * gap}px + ${offset}), 1px)`;
  const left = across(slot.rect.left, edge(slot.hasLeft));
  const right = across(slot.rect.left + slot.rect.width, `-1 * ${edge(slot.hasRight)}`);
  const top = down(slot.rect.top, edge(slot.hasAbove));
  const bottom = down(slot.rect.top + slot.rect.height, `-1 * ${edge(slot.hasBelow)}`);
  return { left, top, width: `calc(${right} - ${left})`, height: `calc(${bottom} - ${top})` };
}

export interface ShownSlots {
  slots: LayoutPaneSlot[];
  stripWidth: number;
  fits: boolean;
  unitWidth: number;
  /** The workspace's pane count, whatever is shown. */
  paneCount: number;
}

/**
 * The panes a workspace shows: all of them, the maximized one alone, or below md only its
 * focused one, full size.
 */
export function selectShownSlots(
  workspace: LayoutWorkspace,
  viewport: LayoutViewport,
  narrow: boolean,
  maximizedTabId: string | null,
): ShownSlots {
  const all = selectLayoutPaneSlots(workspace, viewport);
  const paneCount = all.slots.length;
  const maximizedSlot =
    maximizedTabId === null
      ? null
      : (all.slots.find((slot) => slot.activeTabId === maximizedTabId) ?? null);
  if (paneCount < 2 || (!narrow && !maximizedSlot)) return { ...all, paneCount };
  const onlySlot =
    (narrow ? null : maximizedSlot) ??
    all.slots.find((slot) => slot.paneId === workspace.focusedPaneId) ??
    all.slots[0]!;
  return {
    paneCount: narrow ? 1 : paneCount,
    slots: [
      {
        ...onlySlot,
        rect: { ...FULL_RECT },
        hasLeft: false,
        hasRight: false,
        hasAbove: false,
        hasBelow: false,
      },
    ],
    stripWidth: 1,
    fits: true,
    unitWidth: viewport.width,
  };
}
