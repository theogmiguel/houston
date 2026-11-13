/**
 * The layer over the stage's live panes: what a press hits, the focus ring, where the window will
 * land, and the drop lines while a pane is dragged. Rows are laid out by `overviewStage`; the host
 * mounts this inside the stage element `useOverviewStage` zooms.
 */
import { useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

import {
  LayoutOverviewDragChip,
  LayoutOverviewEmptyRow,
  LayoutOverviewFocusRing,
  LayoutOverviewInsertBar,
  LayoutOverviewNewWorkspace,
  LayoutOverviewPane,
  LayoutOverviewRoot,
} from "../components/ui/layout-overlay";
import { chooseOverviewTab } from "./LayoutOverview";
import {
  findLayoutTab,
  type LayoutPaneSlot,
  type LayoutState,
  type LayoutTab,
  type LayoutWorkspace,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  endOverviewGesture,
  getOverviewCamera,
  holdOverviewGesture,
  isOverviewInteractive,
  releaseOverviewGesture,
  requestOverviewOpen,
  type OverviewPhase,
} from "./overviewPhase";
import { overviewRowBox, type OverviewRow, type OverviewStageLayout } from "./overviewStage";

/** Pointer travel before a press on a pane becomes a drag. */
const DRAG_THRESHOLD = 6;

/** What the drag chip shows for a tab. */
export interface OverviewTabLabel {
  readonly icon: ReactNode;
  readonly title: string;
}

// The layer over the live panes: what a press hits, the focus ring, where
// the window will land, and drop lines while a pane is dragged.

type OverviewDropTarget =
  | { kind: "column"; workspaceId: string; index: number }
  | { kind: "workspace"; index: number };

interface OverviewDrag {
  tabId: string;
  point: { x: number; y: number };
  target: OverviewDropTarget | null;
}

/** A background click closes on release; a drag pans instead. Pane drags keep their handler. */
export function onOverviewBackgroundPointerDown(event: React.PointerEvent): void {
  if (event.button !== 0 || !isOverviewInteractive() || !getOverviewCamera()) return;
  if (event.target instanceof Element && event.target.closest("[data-overview-pane]")) return;
  endOverviewGesture();
  const element = event.currentTarget;
  const pointerId = event.pointerId;
  const camera = getOverviewCamera()!;
  const start = { x: event.clientX, y: event.clientY };
  let previous = start;
  let started = false;
  let finished = false;
  const move = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    if (!isOverviewInteractive() || getOverviewCamera() !== camera) return finish(false);
    const point = { x: next.clientX, y: next.clientY };
    if (!started && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) return;
    started = true;
    next.preventDefault();
    camera.pan(point.x - previous.x, point.y - previous.y);
    previous = point;
  };
  const finish = (close: boolean) => {
    if (finished) return;
    finished = true;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("blur", blur);
    element.removeEventListener("lostpointercapture", cancel);
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    releaseOverviewGesture(blur);
    if (close && !started && isOverviewInteractive()) requestOverviewOpen(false);
  };
  const up = (next: PointerEvent) => {
    if (next.pointerId !== pointerId) return;
    move(next);
    finish(true);
  };
  const cancel = (next: Event) => {
    if (next instanceof PointerEvent && next.pointerId === pointerId) finish(false);
  };
  const blur = () => finish(false);
  holdOverviewGesture(blur);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("blur", blur);
  element.addEventListener("lostpointercapture", cancel);
  element.setPointerCapture(pointerId);
  event.preventDefault();
}

export function OverviewStageOverlay({
  layout,
  stage,
  phase: phaseNow,
  onPick,
  resolveTabLabel,
}: {
  layout: LayoutState;
  stage: OverviewStageLayout;
  phase: OverviewPhase;
  /** See `LayoutOverviewProps.onPick`. */
  onPick?: (tab: LayoutTab | null) => void;
  /** The icon and title a tab shows in its pane's tab bar; the host owns tab content. */
  resolveTabLabel: (tab: LayoutTab) => OverviewTabLabel;
}) {
  const choose = (tabId: string | null) => chooseOverviewTab(tabId, onPick);
  const { rows, scale, gap } = stage;
  const [drag, setDrag] = useState<OverviewDrag | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const open = phaseNow === "open" || phaseNow === "opening";
  // Unscaled px that show as `px` on screen once zoomed out.
  const px = (value: number) => `calc(${value}px / var(--overview-scale, ${scale}))`;
  const focusRing = <LayoutOverviewFocusRing style={{ inset: px(-3), borderWidth: px(1.5) }} />;

  const resolveTarget = (
    point: { x: number; y: number },
    tabId: string,
  ): OverviewDropTarget | null => {
    const measured = rows.flatMap((row) => {
      const element = rowRefs.current.get(row.workspace.id);
      return element && row.workspace.columns.length > 0
        ? [{ row, rect: element.getBoundingClientRect() }]
        : [];
    });
    if (measured.length === 0) return null;
    // Inside a row, away from its top and bottom: a new column there.
    for (const { row, rect } of measured) {
      const band = Math.min(20, rect.height / 5);
      if (point.y < rect.top + band || point.y > rect.bottom - band) continue;
      const edges = columnEdges(row);
      const x = (point.x - rect.left) / rect.width;
      let index = 0;
      let best = Number.POSITIVE_INFINITY;
      edges.forEach((edge, edgeIndex) => {
        const distance = Math.abs(edge - x);
        if (distance < best) {
          best = distance;
          index = edgeIndex;
        }
      });
      const target = { kind: "column", workspaceId: row.workspace.id, index } as const;
      return isUsefulColumnDrop(layout, tabId, target) ? target : null;
    }
    // Between rows, above the first or below the last: a new workspace there.
    const stackIndexOf = (workspace: LayoutWorkspace) => layout.workspaces.indexOf(workspace);
    let index = stackIndexOf(measured[0]!.row.workspace);
    for (const { row, rect } of measured) {
      if (point.y > rect.top + rect.height / 2) index = stackIndexOf(row.workspace) + 1;
    }
    return { kind: "workspace", index };
  };

  const beginDrag = (event: React.PointerEvent, tab: LayoutTab) => {
    if (event.button !== 0 || !isOverviewInteractive()) return;
    endOverviewGesture();
    const element = event.currentTarget;
    const tabId = tab.id;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let started = false;
    let finished = false;
    let latest: OverviewDrag | null = null;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const point = { x: moveEvent.clientX, y: moveEvent.clientY };
      if (!started && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) return;
      started = true;
      moveEvent.preventDefault();
      const target = resolveTarget(point, tabId);
      // The chip follows the pointer on its own; the overlay re-renders only
      // when the drop target changes.
      const chip = chipRef.current;
      if (chip) chip.style.transform = chipTransform(point);
      const changed = !latest || !sameDropTarget(latest.target, target);
      latest = { tabId, point, target };
      if (changed) setDrag(latest);
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", stop);
      element.removeEventListener("lostpointercapture", cancel);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      releaseOverviewGesture(stop);
      setDrag(null);
      if (!started) {
        // A plain click opens that pane.
        if (commit) choose(tab.id);
        return;
      }
      const target = latest?.target;
      if (!commit || !target) return;
      const store = useLayoutStore.getState();
      if (target.kind === "column") store.moveChatToColumn(tabId, target.workspaceId, target.index);
      else store.moveTabToNewWorkspace(tabId, target.index);
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(true);
    };
    const cancel = (next: Event) => {
      if (next instanceof PointerEvent && next.pointerId === pointerId) finish(false);
    };
    const stop = () => finish(false);
    holdOverviewGesture(stop);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", stop);
    element.addEventListener("lostpointercapture", cancel);
    element.setPointerCapture(pointerId);
    event.stopPropagation();
  };

  const draggedTab = drag
    ? (findLayoutTab(layout, (tab) => tab.id === drag.tabId)?.tab ?? null)
    : null;
  const focusedRowId = stage.focusedRow.workspace.id;
  const workspaceDropIndex = drag?.target?.kind === "workspace" ? drag.target.index : null;
  const workspaceLineRow =
    workspaceDropIndex === null
      ? null
      : (rows.find((row) => layout.workspaces.indexOf(row.workspace) === workspaceDropIndex)
          ?.index ?? rows.length);

  return (
    <LayoutOverviewRoot
      data-layout-overview=""
      role="dialog"
      aria-label="Workspaces overview"
      open={open}
    >
      {rows.map((row) => {
        const focusedRow = row.workspace.id === focusedRowId;
        const tabsById = new Map<string, LayoutTab>();
        for (const column of row.workspace.columns) {
          for (const pane of column.panes) {
            for (const tab of pane.tabs) tabsById.set(tab.id, tab);
          }
        }
        const insertIndex =
          drag?.target?.kind === "column" && drag.target.workspaceId === row.workspace.id
            ? drag.target.index
            : null;
        const edges = columnEdges(row);
        return (
          <div
            key={row.workspace.id}
            ref={(element) => {
              if (element) rowRefs.current.set(row.workspace.id, element);
              else rowRefs.current.delete(row.workspace.id);
            }}
            data-overview-workspace={row.workspace.id}
            className="absolute"
            style={overviewRowBox(row, gap)}
          >
            {row.slots.map((slot) => {
              const tab = slot.activeTabId ? tabsById.get(slot.activeTabId) : undefined;
              if (!tab) return null;
              const focused = open && focusedRow && row.workspace.focusedPaneId === slot.paneId;
              const dragging = drag !== null && tab.id === drag.tabId;
              return (
                <LayoutOverviewPane
                  key={slot.paneId}
                  data-overview-pane={slot.paneId}
                  data-overview-pane-focused={focused ? "true" : undefined}
                  dragging={dragging}
                  style={paneBox(slot)}
                  onPointerDown={(event) => beginDrag(event, tab)}
                >
                  {focused ? focusRing : null}
                </LayoutOverviewPane>
              );
            })}
            {row.workspace.columns.length === 0 && open ? (
              <>
                <LayoutOverviewEmptyRow style={{ borderWidth: px(1) }} />
                {focusedRow ? focusRing : null}
              </>
            ) : null}
            {insertIndex !== null ? (
              <LayoutOverviewInsertBar
                style={{
                  left: `${(edges[insertIndex] ?? 1) * 100}%`,
                  top: px(-4),
                  bottom: px(-4),
                  width: px(4),
                }}
              />
            ) : null}
          </div>
        );
      })}
      {workspaceLineRow !== null ? (
        <LayoutOverviewNewWorkspace
          style={{
            top: `calc(${workspaceLineRow * 100}% + ${workspaceLineRow * gap - gap / 2}px)`,
            transform: `translateY(-50%) scale(calc(1 / var(--overview-scale, ${scale})))`,
          }}
        />
      ) : null}
      {drag && draggedTab ? (
        <OverviewDragChip ref={chipRef} label={resolveTabLabel(draggedTab)} point={drag.point} />
      ) : null}
    </LayoutOverviewRoot>
  );
}

/** A pane's box inside its row, 4px from each neighbor (the strip's 8px gap). */
function paneBox(slot: LayoutPaneSlot): CSSProperties {
  const side = (has: boolean) => (has ? "4px" : "0px");
  return {
    left: `calc(${slot.rect.left * 100}% + ${side(slot.hasLeft)})`,
    top: `calc(${slot.rect.top * 100}% + ${side(slot.hasAbove)})`,
    width: `calc(${slot.rect.width * 100}% - ${side(slot.hasLeft)} - ${side(slot.hasRight)})`,
    height: `calc(${slot.rect.height * 100}% - ${side(slot.hasAbove)} - ${side(slot.hasBelow)})`,
  };
}

/** Column boundaries of a row as fractions of it, start and end included. */
function columnEdges(row: OverviewRow): number[] {
  const edges = [0];
  for (const column of row.workspace.columns) {
    const slot = row.slots.find((candidate) => candidate.paneId === column.panes[0]?.id);
    edges.push(slot ? slot.rect.left + slot.rect.width : edges.at(-1)!);
  }
  return edges;
}

function isUsefulColumnDrop(
  layout: LayoutState,
  tabId: string,
  target: { workspaceId: string; index: number },
): boolean {
  for (const workspace of layout.workspaces) {
    for (const [columnIndex, column] of workspace.columns.entries()) {
      for (const pane of column.panes) {
        if (!pane.tabs.some((tab) => tab.id === tabId)) continue;
        const alone = column.panes.length === 1 && pane.tabs.length === 1;
        return !(
          alone &&
          workspace.id === target.workspaceId &&
          (target.index === columnIndex || target.index === columnIndex + 1)
        );
      }
    }
  }
  return false;
}

function chipTransform(point: { x: number; y: number }): string {
  return `translate(${point.x - 20}px, ${point.y - 14}px)`;
}

function sameDropTarget(a: OverviewDropTarget | null, b: OverviewDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "workspace") return b.kind === "workspace" && a.index === b.index;
  return b.kind === "column" && a.workspaceId === b.workspaceId && a.index === b.index;
}

/** What follows the pointer while a pane is dragged: its tab label. */
function OverviewDragChip({
  ref,
  label,
  point,
}: {
  ref: Ref<HTMLDivElement>;
  label: OverviewTabLabel;
  point: { x: number; y: number };
}) {
  return createPortal(
    <LayoutOverviewDragChip ref={ref} style={{ transform: chipTransform(point) }}>
      {label.icon}
      <span className="min-w-0 truncate">{label.title}</span>
    </LayoutOverviewDragChip>,
    document.body,
  );
}
