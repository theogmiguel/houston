/**
 * The overview's stage: every workspace laid out at full size, one row per workspace, in units of
 * the strip's own box. The zoom only transforms it, so everything here is arithmetic over the
 * layout and the window's size.
 */
import type { CSSProperties } from "react";

import {
  selectLayoutPaneSlots,
  selectWindowStartPaneId,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutViewport,
  type LayoutWorkspace,
} from "./layoutModel";

/** The largest share of the window a window-wide pane takes zoomed out. */
const OVERVIEW_SCALE = 0.3625;
/** Widest share of the window a zoomed-out row may take, so its edges stay on screen. */
const OVERVIEW_MAX_ROW_SHARE = 0.92;
/** On-screen px between workspace rows, so rows read as separate. */
export const OVERVIEW_ROW_GAP = 24;

export interface OverviewRow {
  workspace: LayoutWorkspace;
  /** Row position in the stack, from the top. */
  index: number;
  stripWidth: number;
  slots: LayoutPaneSlot[];
}

export interface OverviewStageLayout {
  rows: OverviewRow[];
  focusedRow: OverviewRow;
  scale: number;
  /** Unscaled px between rows, so `OVERVIEW_ROW_GAP` shows on screen. */
  gap: number;
}

export interface StageTransform {
  x: number;
  y: number;
  scale: number;
}

/** The part of a `DOMRect` the stage math reads. */
export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

/** Where the strip was scrolled, which workspace it showed, and how far a switch had carried it. */
export interface OverviewEntry {
  scrollLeft: number;
  workspaceId: string;
  rowOffset: number;
}

/** An empty workspace only shows while it is the focused one. */
export function overviewWorkspaces(layout: LayoutState): LayoutWorkspace[] {
  return layout.workspaces.filter(
    (workspace) => workspace.columns.length > 0 || workspace.id === layout.focusedWorkspaceId,
  );
}

/**
 * `windowWidth` is the window's px width; `viewport.width` the strip's, the
 * unit rows are laid out in. The scale keeps on-screen sizes window relative.
 */
export function selectOverviewStage(
  layout: LayoutState,
  viewport: LayoutViewport,
  windowWidth: number,
): OverviewStageLayout {
  const rows = overviewWorkspaces(layout).map((workspace, index) => ({
    workspace,
    index,
    ...selectLayoutPaneSlots(workspace, viewport),
  }));
  const widest = Math.max(1, ...rows.map((row) => row.stripWidth));
  const toWindow = viewport.width > 0 ? windowWidth / viewport.width : 1;
  const scale = Math.min(OVERVIEW_SCALE, OVERVIEW_MAX_ROW_SHARE / widest) * toWindow;
  const focusedRow = rows.find((row) => row.workspace.id === layout.focusedWorkspaceId) ?? rows[0]!;
  return { rows, focusedRow, scale, gap: OVERVIEW_ROW_GAP / scale };
}

/** Rows a workspace on both stages moved down, as when a new workspace opens above the stack. */
export function overviewRowShift(previous: OverviewRow[], next: OverviewRow[]): number {
  for (const row of next) {
    const before = previous.find((candidate) => candidate.workspace.id === row.workspace.id);
    if (before) return row.index - before.index;
  }
  return 0;
}

/** Rows are centered on the stage; a row wider than the window starts left of it. */
export function overviewRowLeftShare(row: OverviewRow): number {
  return (1 - row.stripWidth) / 2;
}

export function overviewRowBox(row: OverviewRow, gap: number): CSSProperties {
  return {
    left: `${overviewRowLeftShare(row) * 100}%`,
    top: `calc(${row.index * 100}% + ${row.index * gap}px)`,
    width: `${row.stripWidth * 100}%`,
    height: "100%",
  };
}

/** A pane's box on the stage; `edge` is the half gap on each side with a neighbor. */
export function overviewSlotStyle(
  row: OverviewRow,
  slot: LayoutPaneSlot,
  gap: number,
  edge: string,
): CSSProperties {
  const side = (has: boolean) => (has ? edge : "0px");
  const left = overviewRowLeftShare(row) + slot.rect.left * row.stripWidth;
  return {
    left: `calc(${left * 100}% + ${side(slot.hasLeft)})`,
    top: `calc(${(row.index + slot.rect.top) * 100}% + ${row.index * gap}px + ${side(slot.hasAbove)})`,
    width: `calc(${slot.rect.width * row.stripWidth * 100}% - ${side(slot.hasLeft)} - ${side(slot.hasRight)})`,
    height: `calc(${slot.rect.height * 100}% - ${side(slot.hasAbove)} - ${side(slot.hasBelow)})`,
  };
}

/**
 * Where the strip will scroll when the overview zooms into `row`: where it
 * was if that workspace was on screen, moved just enough to show its
 * focused pane.
 */
export function overviewExitScrollLeft(
  row: OverviewRow,
  width: number,
  entry: OverviewEntry,
): number {
  const stripPx = row.stripWidth * width;
  let scroll = row.workspace.id === entry.workspaceId ? entry.scrollLeft : 0;
  const slot = row.slots.find((candidate) => candidate.paneId === row.workspace.focusedPaneId);
  if (slot) {
    const left = slot.rect.left * stripPx;
    const right = left + slot.rect.width * stripPx;
    if (left < scroll) scroll = left;
    else if (right > scroll + width) scroll = Math.min(left, right - width);
  }
  return Math.max(0, Math.min(stripPx - width, scroll));
}

export function selectOverviewStartPaneIds(
  stage: OverviewStageLayout,
  width: number,
  entry: OverviewEntry,
): ReadonlySet<string> {
  const startPaneIds = new Set<string>();
  for (const row of stage.rows) {
    const stripPx = row.stripWidth * width;
    const startPaneId = selectWindowStartPaneId(
      row.slots,
      overviewExitScrollLeft(row, width, entry),
      stripPx,
    );
    for (const slot of row.slots) {
      if (startPaneId === null ? !slot.hasLeft && !slot.hasAbove : slot.paneId === startPaneId) {
        startPaneIds.add(slot.paneId);
      }
    }
  }
  return startPaneIds;
}

/** The stage as the window shows it outside the overview: `row` scrolled to `scroll`. */
export function overviewZoomedIn(
  stage: OverviewStageLayout,
  row: OverviewRow,
  scroll: number,
  box: StageBox,
): StageTransform {
  return {
    x: -(overviewRowLeftShare(row) * box.width + scroll),
    y: -(row.index * (box.height + stage.gap)),
    scale: 1,
  };
}

/** The stage zoomed out, the focused row centered in the window. */
export function overviewZoomedOut(
  stage: OverviewStageLayout,
  box: StageBox,
  window: WindowSize,
  scale = stage.scale,
): StageTransform {
  const row = stage.focusedRow;
  const slot =
    scale === stage.scale
      ? null
      : row.slots.find((candidate) => candidate.paneId === row.workspace.focusedPaneId);
  const centerX = slot
    ? (overviewRowLeftShare(row) + (slot.rect.left + slot.rect.width / 2) * row.stripWidth) *
      box.width
    : box.width / 2;
  const rowCenter =
    row.index * (box.height + stage.gap) +
    (slot ? slot.rect.top + slot.rect.height / 2 : 0.5) * box.height;
  return {
    x: window.width / 2 - box.left - scale * centerX,
    y: window.height / 2 - box.top - scale * rowCenter,
    scale,
  };
}

/** Reach either end of the real rows without panning the entire stage out of view. */
export function boundOverviewTransform(
  stage: OverviewStageLayout,
  box: StageBox,
  transform: StageTransform,
  footerHeight: number,
  window: WindowSize,
): StageTransform {
  const widest = Math.max(1, ...stage.rows.map((row) => row.stripWidth));
  const bound = (value: number, start: number, end: number, origin: number, extent: number) => {
    const near = OVERVIEW_ROW_GAP - origin - transform.scale * start;
    const far =
      Math.max(OVERVIEW_ROW_GAP, extent - OVERVIEW_ROW_GAP) - origin - transform.scale * end;
    return Math.max(Math.min(near, far), Math.min(Math.max(near, far), value));
  };
  return {
    ...transform,
    x: bound(
      transform.x,
      ((1 - widest) * box.width) / 2,
      ((1 + widest) * box.width) / 2,
      box.left,
      window.width,
    ),
    y: bound(
      transform.y,
      0,
      (stage.rows.length - 1) * (box.height + stage.gap) + box.height,
      box.top,
      window.height - footerHeight,
    ),
  };
}
