import { LayoutGridIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useReducedMotion } from "../../hooks/useReducedMotion";
import { MAX_GRID_THREADS, type GridRecord } from "../../grid/gridStore";
import {
  THREAD_DROP_REFUSAL_LABEL,
  threadDropRefusal,
  type ThreadDropRefusal,
} from "../../grid/projectMove";
import {
  beginThreadDrag,
  useThreadDragSource,
  useThreadDropTarget,
  useThreadDropZone,
  type ThreadDragSource,
  type ThreadDropTarget,
} from "../../grid/threadDrag";
import {
  type LayoutNode,
  type Side,
  type SplitNode,
  type SplitSide,
  type ThreadNode,
  clampSplitRatio,
  findThread,
  insertBeside,
  moveThread,
  preorderThreads,
  quadrant,
  removeThread,
  setRatio,
  swapThread,
  threadLeaf,
} from "../../grid/tree";
import { presetOf, snapSplitRatio, splitFractionLabel, stepSplitPreset } from "../../grid/resize";
import { beginLayoutResize, endLayoutResize } from "../../motion/layoutResize";
import { animateMaximizeMorph, type CellRect } from "../../motion/maximizeMotion";
import { offsetWithin, useGridCellFlip } from "../../motion/paneMotion";
import { GRID_BADGE_LINGER_MS, SNAP_DISTANCE_PX } from "../../motion/timings";
import { announce } from "../../lib/announce";
import { observeResize } from "../../lib/observeResize";
import { suppressTextSelection } from "../../lib/suppressTextSelection";
import { GridResizeDivider } from "../ui/grid-resize-divider";

export interface GridCellRenderProps {
  node: ThreadNode;
  focused: boolean;
  /** The grid is showing this cell alone; the others keep running in the tree. */
  maximized: boolean;
  onClose: () => void;
  /** Removes the cell without offering a reopen, for a thread archived elsewhere. */
  onArchiveClose: () => void;
  onSplit: (side: SplitSide, threadId: string) => void;
  /** This cell is the thread being dragged; it dims until the drop. */
  dragging: boolean;
  /** Where a thread dropped on this cell would land, for the drop indicator. */
  dropIndicator: Side | null;
  /** The cell refuses the drop; the indicator replaces the landing hint. */
  dropRefusal: ThreadDropRefusal | null;
  /** Starts the drag from the cell's label; absent when the cell cannot move. */
  onDragHandlePointerDown?: ((event: ReactPointerEvent<HTMLElement>) => void) | undefined;
}

/** The gap between cards; it is also each resize handle's width. */
const GUTTER_PX = 8;

/** Matches `--grid-morph-duration` in index.css; a closing cell is removed once it has shrunk away. */
const GRID_MORPH_MS = 260;

export interface GridHostProps {
  grid: GridRecord;
  onTreeChange: (tree: LayoutNode | null) => void;
  onFocusThread: (threadId: string) => void;
  /**
   * Closes a cell through the grid store, which remembers its slot. A returned promise keeps
   * the cell leaving until it settles; a thread still in the tree then comes back.
   */
  onCloseThread?: (threadId: string) => void | Promise<unknown>;
  /** Shows one cell alone without changing the tree or its sizes. */
  maximizedThreadId?: string | null;
  /** Moves a thread from outside this grid onto one of its cells. */
  onDropThread?: (source: ThreadDragSource, targetThreadId: string, side: Side) => void;
  renderThread: (cell: GridCellRenderProps) => ReactNode;
  renderEmpty?: () => ReactNode;
}

export function GridHost(props: GridHostProps) {
  const {
    grid,
    onTreeChange,
    onFocusThread,
    onCloseThread,
    maximizedThreadId,
    onDropThread,
    renderThread,
    renderEmpty,
  } = props;
  const tree = grid.tree;
  const dragSource = useThreadDragSource();
  const dragTarget = useThreadDropTarget();
  const reducedMotion = useReducedMotion();
  const [leavingThreadId, setLeavingThreadId] = useState<string | null>(null);

  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const threadIds = tree === null ? [] : preorderThreads(tree).map((leaf) => leaf.threadId);
  const threadCount = threadIds.length;
  // Cells that joined since the last tree of this grid grow in; a grid switch is not a join.
  const threadIdsKey = `${grid.id}\n${threadIds.join("\n")}`;
  const [shownTree, setShownTree] = useState({ key: threadIdsKey, gridId: grid.id, threadIds });
  const [enteringThreadIds, setEnteringThreadIds] = useState<ReadonlySet<string>>(EMPTY_IDS);
  if (shownTree.key !== threadIdsKey) {
    const before = new Set(shownTree.threadIds);
    const joined =
      shownTree.gridId === grid.id && before.size > 0
        ? threadIds.filter((threadId) => !before.has(threadId))
        : [];
    setShownTree({ key: threadIdsKey, gridId: grid.id, threadIds });
    setEnteringThreadIds(joined.length === 0 ? EMPTY_IDS : new Set(joined));
  }
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- ends the join animation once its cells have grown in
  useEffect(() => {
    if (enteringThreadIds.size === 0) return;
    const timer = window.setTimeout(() => setEnteringThreadIds(EMPTY_IDS), GRID_MORPH_MS);
    return () => window.clearTimeout(timer);
  }, [enteringThreadIds]);

  // Where each frame was last placed, so a maximize can morph from the box it leaves.
  const placedRects = useRef(new Map<string, CellRect>());
  const shownMaximize = useRef({ gridId: grid.id, threadId: maximizedThreadId ?? null });
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- places the cell frames over their layout boxes before paint, and again whenever a box resizes
  useLayoutEffect(() => {
    const root = surfaceRef.current;
    if (root === null) return;
    const before = new Map(placedRects.current);
    placeCellFrames(root, placedRects.current);
    const was = shownMaximize.current;
    const now = { gridId: grid.id, threadId: maximizedThreadId ?? null };
    shownMaximize.current = now;
    const morphedId = now.threadId ?? was.threadId;
    if (was.gridId === now.gridId && was.threadId !== now.threadId && morphedId !== null) {
      morphMaximize(root, morphedId, now.threadId !== null, before, placedRects.current);
    }
    return observeResize([root, ...root.querySelectorAll("[data-cell-place]")], () =>
      placeCellFrames(root, placedRects.current),
    );
  });

  // Cells that existed before a tree change FLIP into their new slots; a join or
  // a leave already animates through the grid's flex transition.
  useGridCellFlip(
    surfaceRef,
    grid.id,
    tree,
    !reducedMotion && enteringThreadIds.size === 0 && leavingThreadId === null,
  );

  const refusalForDrop = (source: ThreadDragSource, side: Side): ThreadDropRefusal | null =>
    threadDropRefusal({
      threadProject: { environmentId: source.environmentId, projectId: source.projectId },
      grid,
      side,
      sourceInTarget: findThread(tree, source.threadId) !== null,
      targetCount: threadCount,
      maxThreads: MAX_GRID_THREADS,
    });

  const announceMove = (side: Side) => {
    announce(
      side === "center"
        ? "Swapped the dragged thread with the cell under the pointer."
        : `Docked the dragged thread at the ${side} of the grid.`,
      `grid-move:${grid.id}`,
    );
  };

  const resolveCellDrop = (
    point: { x: number; y: number },
    source: ThreadDragSource,
  ): ThreadDropTarget | null => {
    const surfaceElement = surfaceRef.current;
    if (surfaceElement === null) return null;
    for (const cell of surfaceElement.querySelectorAll<HTMLElement>(
      "[data-grid-cell][data-thread-id]",
    )) {
      const threadId = cell.dataset.threadId;
      if (threadId === undefined || cell.closest("[inert]") !== null) continue;
      const rect = cell.getBoundingClientRect();
      if (
        point.x < rect.left ||
        point.x > rect.right ||
        point.y < rect.top ||
        point.y > rect.bottom
      ) {
        continue;
      }
      // A cell never takes its own thread: the drop would change nothing.
      if (source.threadId === threadId) return null;
      const side = quadrant(rect, point.x, point.y);
      return {
        kind: "cell",
        gridId: grid.id,
        threadId,
        side,
        refusal: refusalForDrop(source, side),
      };
    }
    return null;
  };

  const dropOnCell = (source: ThreadDragSource, target: ThreadDropTarget): void => {
    if (target.kind !== "cell") return;
    const { threadId, side, refusal } = target;
    if (refusal !== null) {
      announce(`Drop refused: ${THREAD_DROP_REFUSAL_LABEL[refusal]}.`, `grid-move:${grid.id}`);
      onDropThread?.(source, threadId, side);
      return;
    }
    if (tree !== null && findThread(tree, source.threadId) !== null) {
      onTreeChange(
        side === "center"
          ? swapThread(tree, source.threadId, threadId)
          : moveThread(tree, source.threadId, threadId, side),
      );
      onFocusThread(source.threadId);
      announceMove(side);
      return;
    }
    announceMove(side);
    onDropThread?.(source, threadId, side);
  };

  useThreadDropZone(surfaceRef, resolveCellDrop, dropOnCell);

  const beginCellDrag =
    (threadId: string) =>
    (event: ReactPointerEvent<HTMLElement>): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, [role='button'], a, input, textarea, [contenteditable='true']") !==
          null
      ) {
        return;
      }
      beginThreadDrag(event, {
        gridId: grid.id,
        threadId,
        environmentId: grid.environmentId,
        projectId: grid.projectId,
      });
    };

  const maximizedLeaf =
    tree === null || maximizedThreadId === undefined || maximizedThreadId === null
      ? null
      : findThread(tree, maximizedThreadId);
  const shownLeaving = leavingThreadId !== null && threadIds.includes(leavingThreadId);
  // A leaving cell already counts as gone, so the survivor morphs while it shrinks.
  const multi = maximizedLeaf === null && threadCount - (shownLeaving ? 1 : 0) > 1;
  const surface = (children: ReactNode) => (
    <div
      ref={surfaceRef}
      data-grid-surface=""
      data-multi={multi ? "" : undefined}
      data-morphing={enteringThreadIds.size > 0 ? "" : undefined}
      className="flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {children}
    </div>
  );

  if (tree === null) {
    if (renderEmpty !== undefined) return <>{renderEmpty()}</>;
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <LayoutGridIcon className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">This grid is empty</p>
          <p className="text-xs text-muted-foreground">
            Add a thread from the sidebar. Each thread becomes a cell; split a cell to show several
            threads at once.
          </p>
        </div>
      </div>
    );
  }

  const splitThread = (target: string, side: SplitSide, threadId: string) => {
    onTreeChange(insertBeside(tree, target, threadLeaf(threadId), side));
    onFocusThread(threadId);
  };

  const removeCell = (threadId: string): void | Promise<unknown> => {
    if (onCloseThread !== undefined) return onCloseThread(threadId);
    onTreeChange(removeThread(tree, threadId));
  };

  const closeThread = (threadId: string) => {
    if (reducedMotion || threadCount < 2 || maximizedLeaf !== null) {
      removeCell(threadId);
      return;
    }
    setLeavingThreadId(threadId);
    window.setTimeout(() => {
      void Promise.resolve(removeCell(threadId)).finally(() =>
        setLeavingThreadId((current) => (current === threadId ? null : current)),
      );
    }, GRID_MORPH_MS);
  };

  const renderLeaf = (node: ThreadNode, focused: boolean, maximized = false): ReactNode => {
    const cellTarget =
      dragTarget?.kind === "cell" &&
      dragTarget.gridId === grid.id &&
      dragTarget.threadId === node.threadId
        ? dragTarget
        : null;
    const canDrag = threadCount > 1 && maximizedThreadId == null;
    return renderThread({
      node,
      focused,
      maximized,
      onClose: () => closeThread(node.threadId),
      onArchiveClose: () => onTreeChange(removeThread(tree, node.threadId)),
      onSplit: (side, threadId) => splitThread(node.threadId, side, threadId),
      dragging: dragSource?.threadId === node.threadId,
      dropIndicator: cellTarget?.side ?? null,
      dropRefusal: cellTarget?.refusal ?? null,
      ...(canDrag ? { onDragHandlePointerDown: beginCellDrag(node.threadId) } : {}),
    });
  };

  // Sorted by id, not by place: a cell's frame never moves in the DOM, whatever the layout does.
  const leaves = preorderThreads(tree).toSorted((left, right) =>
    left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0,
  );
  // Each frame starts at its layout box, so whatever a cell measures on mount is already right.
  const boxes = cellBoxes(tree, threadCount > 1);

  return surface(
    <>
      {maximizedLeaf !== null ? (
        <CellPlace threadId={maximizedLeaf.threadId} />
      ) : (
        <GridBranch
          node={tree}
          path={[]}
          leavingThreadId={shownLeaving ? leavingThreadId : null}
          enteringThreadIds={enteringThreadIds}
          onTreeChange={(next) => onTreeChange(next)}
        />
      )}
      {leaves.map((leaf) => (
        <div
          key={leaf.threadId}
          data-grid-cell-frame={leaf.threadId}
          data-leaving={shownLeaving && leaf.threadId === leavingThreadId ? "" : undefined}
          data-entering={enteringThreadIds.has(leaf.threadId) ? "" : undefined}
          className="absolute flex min-h-0 min-w-0"
          style={
            maximizedLeaf !== null && leaf.threadId === maximizedLeaf.threadId
              ? { left: 0, top: 0, width: "100%", height: "100%" }
              : boxes.get(leaf.threadId)
          }
        >
          {maximizedLeaf !== null
            ? renderLeaf(leaf, leaf.threadId === maximizedLeaf.threadId, true)
            : renderLeaf(leaf, leaf.threadId === grid.focusedThreadId)}
        </div>
      ))}
    </>,
  );
}

interface Linear {
  /** Share of the surface's padding box. */
  readonly share: number;
  readonly px: number;
}

function linear(share: number, px: number): Linear {
  return { share, px };
}

function cssLength({ share, px }: Linear): string {
  return `calc(${share * 100}% + ${px}px)`;
}

/**
 * Every cell's box as CSS lengths of the surface, worked out from the split weights the
 * way flex lays the slots out (flex-basis 0, fixed gutters). The frames follow the
 * measured slots after mount; this is what they show before that first measurement.
 */
function cellBoxes(tree: LayoutNode, multi: boolean): Map<string, CSSProperties> {
  const pad = multi ? GUTTER_PX : 0;
  const boxes = new Map<string, CSSProperties>();
  const visit = (node: LayoutNode, x: Linear, y: Linear, width: Linear, height: Linear) => {
    if (node.kind === "thread") {
      boxes.set(node.threadId, {
        left: cssLength(x),
        top: cssLength(y),
        width: cssLength(width),
        height: cssLength(height),
      });
      return;
    }
    const along = node.dir === "row" ? width : height;
    const gutters = (node.children.length - 1) * GUTTER_PX;
    const total = node.weights.reduce((sum, weight) => sum + weight, 0) || 1;
    let offset = node.dir === "row" ? x : y;
    node.children.forEach((child, index) => {
      const ratio = (node.weights[index] ?? 0) / total;
      const size = linear(along.share * ratio, (along.px - gutters) * ratio);
      if (node.dir === "row") visit(child, offset, y, size, height);
      else visit(child, x, offset, width, size);
      offset = linear(offset.share + size.share, offset.px + size.px + GUTTER_PX);
    });
  };
  visit(tree, linear(0, pad), linear(0, pad), linear(1, -2 * pad), linear(1, -2 * pad));
  return boxes;
}

/** Where a cell shows: the layout sizes this box, and the cell's frame is placed over it. */
function CellPlace({ threadId }: { threadId: string }) {
  return <div data-cell-place={threadId} className="flex min-h-0 min-w-0 flex-1" />;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Puts every cell frame over its layout box, so a swap, a split or a maximize only
 * moves boxes and each cell keeps its DOM, scroll position and React state. A cell
 * hidden behind a maximized one keeps its last size, so showing it costs no relayout.
 */
function placeCellFrames(root: HTMLElement, placed: Map<string, CellRect>): void {
  const places = new Map<string, HTMLElement>();
  for (const place of root.querySelectorAll<HTMLElement>("[data-cell-place]")) {
    const threadId = place.dataset.cellPlace;
    if (threadId !== undefined) places.set(threadId, place);
  }
  for (const frame of root.querySelectorAll<HTMLElement>(":scope > [data-grid-cell-frame]")) {
    const place = places.get(frame.dataset.gridCellFrame ?? "");
    const offset = place === undefined ? null : offsetWithin(place, root);
    const shown = place !== undefined && offset !== null;
    if (frame.inert === shown) frame.inert = !shown;
    frame.style.visibility = shown ? "" : "hidden";
    if (!shown) continue;
    setPx(frame, "left", offset.x);
    setPx(frame, "top", offset.y);
    setPx(frame, "width", place.offsetWidth);
    setPx(frame, "height", place.offsetHeight);
    placed.set(place.dataset.cellPlace ?? "", {
      x: offset.x,
      y: offset.y,
      width: place.offsetWidth,
      height: place.offsetHeight,
    });
  }
}

/** Starts the maximize or restore morph of `threadId` from its last box to its new one. */
function morphMaximize(
  root: HTMLElement,
  threadId: string,
  opening: boolean,
  before: ReadonlyMap<string, CellRect>,
  after: ReadonlyMap<string, CellRect>,
): void {
  const from = before.get(threadId);
  const to = after.get(threadId);
  const frames = [...root.querySelectorAll<HTMLElement>(":scope > [data-grid-cell-frame]")];
  const frame = frames.find((candidate) => candidate.dataset.gridCellFrame === threadId);
  const cell = frame?.querySelector<HTMLElement>("[data-grid-cell]");
  if (from === undefined || to === undefined || cell == null) return;
  animateMaximizeMorph(
    root,
    cell,
    from,
    to,
    opening,
    frames.filter((candidate) => candidate !== frame),
  );
}

function setPx(element: HTMLElement, property: "left" | "top" | "width" | "height", value: number) {
  const next = `${value}px`;
  if (element.style[property] !== next) element.style[property] = next;
}

function GridBranch({
  node,
  path,
  leavingThreadId,
  enteringThreadIds,
  onTreeChange,
}: {
  node: LayoutNode;
  path: number[];
  leavingThreadId: string | null;
  enteringThreadIds: ReadonlySet<string>;
  onTreeChange: (tree: LayoutNode) => void;
}) {
  if (node.kind === "thread") {
    return <CellPlace threadId={node.threadId} />;
  }
  return (
    <SplitView
      node={node}
      path={path}
      leavingThreadId={leavingThreadId}
      enteringThreadIds={enteringThreadIds}
      onTreeChange={onTreeChange}
    />
  );
}

interface ResizeDrag {
  index: number;
  startCoord: number;
  /** The pixel width the pair had when the drag started. */
  pairPx: number;
  startValue: number;
  /** The share the first cell shows now, kept current through the drag. */
  value: number;
  snapped: number | null;
  pairSum: number;
}

function SplitView({
  node,
  path,
  leavingThreadId,
  enteringThreadIds,
  onTreeChange,
}: {
  node: SplitNode;
  path: number[];
  leavingThreadId: string | null;
  enteringThreadIds: ReadonlySet<string>;
  onTreeChange: (tree: LayoutNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const badgeRefs = useRef<Array<HTMLDivElement | null>>([]);
  const badgeTimerRefs = useRef<Array<number | null>>([]);
  const badgeStateRefs = useRef<Array<{ text: string; snapped: boolean; visible: boolean } | null>>(
    [],
  );
  const dragRef = useRef<ResizeDrag | null>(null);
  const releaseSelectionRef = useRef<(() => void) | null>(null);
  const frameRef = useRef<number | null>(null);
  const coordRef = useRef(0);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const isLeaving = (child: LayoutNode) =>
    leavingThreadId !== null &&
    preorderThreads(child).every((leaf) => leaf.threadId === leavingThreadId);
  const isEntering = (child: LayoutNode) =>
    enteringThreadIds.size > 0 &&
    preorderThreads(child).every((leaf) => enteringThreadIds.has(leaf.threadId));
  const leavingIndex = node.children.findIndex(isLeaving);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- clears the badge timer and the pending resize frame when the divider unmounts
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      for (const timer of badgeTimerRefs.current) {
        if (timer !== null && timer !== undefined) window.clearTimeout(timer);
      }
      if (dragRef.current !== null) endLayoutResize();
    },
    [],
  );

  // The badge is painted from a ref, not React state, so pointer moves never
  // re-render the cells. A re-render can replace its node, and the ref callback
  // repaints the drag's state onto the new one.
  const paintBadge = (index: number) => {
    const badge = badgeRefs.current[index];
    const state = badgeStateRefs.current[index];
    if (badge == null || state == null || !state.visible) {
      if (badge != null) badge.style.display = "none";
      return;
    }
    badge.textContent = state.text;
    if (state.snapped) badge.dataset.snapped = "";
    else delete badge.dataset.snapped;
    badge.style.display = "inline-block";
  };

  const showBadge = (index: number, value: number, snapped: number | null, holdMs = 0) => {
    badgeStateRefs.current[index] = {
      text: `${splitFractionLabel(value, snapped)} width`,
      snapped: snapped !== null,
      visible: true,
    };
    paintBadge(index);
    const timer = badgeTimerRefs.current[index];
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    badgeTimerRefs.current[index] =
      holdMs > 0 ? window.setTimeout(() => hideBadge(index), holdMs) : null;
  };

  const hideBadge = (index: number) => {
    const timer = badgeTimerRefs.current[index];
    if (timer !== null && timer !== undefined) window.clearTimeout(timer);
    badgeTimerRefs.current[index] = null;
    badgeStateRefs.current[index] = null;
    paintBadge(index);
  };

  const measureSpace = () => {
    const container = containerRef.current;
    const span =
      container === null ? 0 : node.dir === "row" ? container.clientWidth : container.clientHeight;
    return Math.max(0, span - (node.children.length - 1) * GUTTER_PX);
  };

  const pairPx = (index: number) => {
    const pairSum = (node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1;
    return (measureSpace() * pairSum) / 100;
  };

  const applyPreview = (drag: ResizeDrag, clientCoord: number) => {
    const extent = drag.pairPx;
    if (extent <= 0) return;
    const raw = drag.startValue + (clientCoord - drag.startCoord) / extent;
    const snapped = snapSplitRatio(raw, extent, SNAP_DISTANCE_PX);
    const value = clampSplitRatio(snapped.value, extent);
    drag.value = value;
    drag.snapped = snapped.snapped;
    const first = slotRefs.current[drag.index];
    const second = slotRefs.current[drag.index + 1];
    if (first != null) first.style.flexGrow = String(value * drag.pairSum);
    if (second != null) second.style.flexGrow = String((1 - value) * drag.pairSum);
    showBadge(drag.index, value, presetOf(value));
  };

  // Writes the committed weights back: React skips an unchanged style prop, so clearing the
  // preview would leave the slot with no flex-grow and zero width.
  const restoreSlots = () => {
    node.children.forEach((_, index) => {
      const slot = slotRefs.current[index];
      if (slot != null) slot.style.flexGrow = String(node.weights[index] ?? 1);
    });
  };

  const finishDrag = (commit: () => void) => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    releaseSelectionRef.current?.();
    releaseSelectionRef.current = null;
    commit();
    endLayoutResize();
    setDraggingIndex(null);
  };

  const commitRatio = (index: number, value: number) => {
    onTreeChange(setRatio(node, path, index, value));
  };

  const endPointerDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (drag === null) return;
    if (!cancelled) applyPreview(drag, node.dir === "row" ? event.clientX : event.clientY);
    const current = dragRef.current;
    if (cancelled || current === null) {
      finishDrag(restoreSlots);
      hideBadge(drag.index);
      return;
    }
    // A click on the divider is not a resize: it must not write the tree.
    const changed = Math.abs(current.value - current.startValue) > 1e-4;
    finishDrag(() => {
      if (changed) commitRatio(current.index, current.value);
      else restoreSlots();
    });
    if (!changed) {
      hideBadge(current.index);
      return;
    }
    // The badge keeps the final fraction readable after the pointer lets go.
    showBadge(current.index, current.value, current.snapped, GRID_BADGE_LINGER_MS);
  };

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      style={{ flexDirection: node.dir === "row" ? "row" : "column" }}
    >
      {node.children.map((child, index) => (
        <div
          key={
            child.kind === "thread"
              ? child.id
              : (preorderThreads(child)[0]?.id ?? `split-${path.join(".")}-${index}`)
          }
          className="contents"
        >
          <div
            data-grid-slot=""
            ref={(element) => {
              slotRefs.current[index] = element;
            }}
            data-leaving={index === leavingIndex ? "" : undefined}
            data-entering={isEntering(child) ? "" : undefined}
            className="relative flex min-h-0 min-w-0 overflow-hidden"
            style={
              {
                flexGrow: node.weights[index] ?? 1,
                flexBasis: 0,
                minWidth: 0,
                minHeight: 0,
              } satisfies CSSProperties
            }
          >
            <GridBranch
              node={child}
              path={[...path, index]}
              leavingThreadId={leavingThreadId}
              enteringThreadIds={enteringThreadIds}
              onTreeChange={onTreeChange}
            />
          </div>
          {index < node.children.length - 1 ? (
            <GridResizeDivider
              orientation={node.dir === "row" ? "vertical" : "horizontal"}
              valueNow={Math.round(
                ((node.weights[index] ?? 0) /
                  ((node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1)) *
                  100,
              )}
              dragging={draggingIndex === index}
              // The gutter beside a leaving cell closes with it, so nothing jumps when it is removed.
              leaving={
                leavingIndex !== -1 && (index === leavingIndex || index === leavingIndex - 1)
              }
              style={{ flexBasis: GUTTER_PX }}
              badgeRef={(element) => {
                badgeRefs.current[index] = element;
                // A re-render replaces the node; repaint the drag's state onto it.
                if (element !== null) paintBadge(index);
              }}
              onDoubleClick={() => {
                const extent = pairPx(index);
                const value = clampSplitRatio(0.5, extent);
                commitRatio(index, value);
                showBadge(index, value, presetOf(value), GRID_BADGE_LINGER_MS);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || dragRef.current !== null) return;
                const extent = pairPx(index);
                if (extent <= 0) return;
                // No preventDefault: cancelling pointerdown also cancels the click
                // that double-click needs. The container holds selection instead.
                releaseSelectionRef.current?.();
                releaseSelectionRef.current =
                  containerRef.current === null
                    ? null
                    : suppressTextSelection(containerRef.current);
                event.currentTarget.setPointerCapture(event.pointerId);
                const pairSum = (node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1;
                dragRef.current = {
                  index,
                  startCoord: node.dir === "row" ? event.clientX : event.clientY,
                  pairPx: extent,
                  startValue: (node.weights[index] ?? 0) / pairSum,
                  value: (node.weights[index] ?? 0) / pairSum,
                  snapped: null,
                  pairSum,
                };
                beginLayoutResize();
                setDraggingIndex(index);
                showBadge(index, dragRef.current.startValue, null);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (drag === null || frameRef.current !== null) return;
                coordRef.current = node.dir === "row" ? event.clientX : event.clientY;
                frameRef.current = requestAnimationFrame(() => {
                  frameRef.current = null;
                  applyPreview(drag, coordRef.current);
                });
              }}
              onPointerUp={(event) => endPointerDrag(event, false)}
              onPointerCancel={(event) => endPointerDrag(event, true)}
              onLostPointerCapture={() => {
                if (dragRef.current !== null) finishDrag(restoreSlots);
              }}
              onKeyDown={(event) => {
                const decrease = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
                const increase = node.dir === "row" ? "ArrowRight" : "ArrowDown";
                if (event.key !== decrease && event.key !== increase) return;
                event.preventDefault();
                const pairSum = (node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1;
                const current = (node.weights[index] ?? 0) / pairSum;
                const next = stepSplitPreset(current, event.key === increase ? 1 : -1);
                if (Math.abs(next - current) < 1e-3) return;
                const value = clampSplitRatio(next, pairPx(index));
                commitRatio(index, value);
                showBadge(index, value, presetOf(value), GRID_BADGE_LINGER_MS);
              }}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
