import { LayoutGridIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";

import { MAX_GRID_THREADS, type GridRecord } from "../../grid/gridStore";
import {
  beginThreadDrag,
  endThreadDrag,
  hasThreadDrag,
  useThreadDragSource,
  writeThreadDrag,
  type ThreadDragHandleProps,
  type ThreadDragSource,
  type ThreadDropTargetProps,
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
import { cn } from "../../lib/utils";

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
  dragHandleProps: ThreadDragHandleProps;
  dropTargetProps: ThreadDropTargetProps;
}

const GUTTER_PX = 0;

export interface GridHostProps {
  grid: GridRecord;
  onTreeChange: (tree: LayoutNode | null) => void;
  onFocusThread: (threadId: string) => void;
  /** Closes a cell through the grid store, which remembers its slot. */
  onCloseThread?: (threadId: string) => void;
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
  const [hover, setHover] = useState<{ threadId: string; side: Side } | null>(null);

  const threadCount = tree === null ? 0 : preorderThreads(tree).length;
  const atCap = threadCount >= MAX_GRID_THREADS;
  const sourceInTree =
    dragSource !== null &&
    dragSource.gridId === grid.id &&
    tree !== null &&
    findThread(tree, dragSource.threadId) !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Escape must cancel a drag whose source cell the pointer left
  useEffect(() => {
    if (dragSource === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      endThreadDrag();
      setHover(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dragSource]);

  const sideForDrop = (threadId: string, event: DragEvent<HTMLElement>): Side | null => {
    if (dragSource === null || dragSource.threadId === threadId) return null;
    const side = quadrant(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    // Edges add a cell; a grid at the cap only accepts a centre drop, which replaces.
    if (side !== "center" && !sourceInTree && atCap) return null;
    return side;
  };

  const handleDragStart =
    (threadId: string) =>
    (event: DragEvent<HTMLElement>): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, [role='button'], a, input, textarea, [contenteditable='true']") !==
          null
      ) {
        event.preventDefault();
        return;
      }
      const source = { gridId: grid.id, threadId };
      writeThreadDrag(event.dataTransfer, source);
      beginThreadDrag(source);
    };

  const handleDragEnd = (): void => {
    endThreadDrag();
    setHover(null);
  };

  const handleDragOver =
    (threadId: string) =>
    (event: DragEvent<HTMLElement>): void => {
      if (dragSource === null && !hasThreadDrag(event.dataTransfer)) return;
      const side = sideForDrop(threadId, event);
      if (side === null) {
        event.dataTransfer.dropEffect = "none";
        setHover(null);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setHover((current) =>
        current?.threadId === threadId && current.side === side ? current : { threadId, side },
      );
    };

  const handleDragLeave =
    (threadId: string) =>
    (event: DragEvent<HTMLElement>): void => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setHover((current) => (current?.threadId === threadId ? null : current));
    };

  const handleDrop =
    (threadId: string) =>
    (event: DragEvent<HTMLElement>): void => {
      if (dragSource === null && !hasThreadDrag(event.dataTransfer)) return;
      const side = sideForDrop(threadId, event);
      const source = dragSource;
      setHover(null);
      endThreadDrag();
      if (source === null || side === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        source.gridId === grid.id &&
        tree !== null &&
        findThread(tree, source.threadId) !== null
      ) {
        onTreeChange(
          side === "center"
            ? swapThread(tree, source.threadId, threadId)
            : moveThread(tree, source.threadId, threadId, side),
        );
        onFocusThread(source.threadId);
        return;
      }
      onDropThread?.(source, threadId, side);
    };

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

  const closeThread = (threadId: string) => {
    if (onCloseThread !== undefined) {
      onCloseThread(threadId);
      return;
    }
    onTreeChange(removeThread(tree, threadId));
  };

  const renderLeaf = (node: ThreadNode, focused: boolean, maximized = false): ReactNode =>
    renderThread({
      node,
      focused,
      maximized,
      onClose: () => closeThread(node.threadId),
      onArchiveClose: () => onTreeChange(removeThread(tree, node.threadId)),
      onSplit: (side, threadId) => splitThread(node.threadId, side, threadId),
      dragging: dragSource?.threadId === node.threadId,
      dropIndicator: dragSource !== null && hover?.threadId === node.threadId ? hover.side : null,
      dragHandleProps: {
        draggable: threadCount > 1 && maximizedThreadId == null,
        onDragStart: handleDragStart(node.threadId),
        onDragEnd: handleDragEnd,
      },
      dropTargetProps: {
        onDragOver: handleDragOver(node.threadId),
        onDragLeave: handleDragLeave(node.threadId),
        onDrop: handleDrop(node.threadId),
      },
    });

  const maximizedLeaf =
    maximizedThreadId === undefined || maximizedThreadId === null
      ? null
      : findThread(tree, maximizedThreadId);
  if (maximizedLeaf !== null) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {renderLeaf(maximizedLeaf, true, true)}
      </div>
    );
  }

  return (
    <GridBranch
      node={tree}
      path={[]}
      focusedThreadId={grid.focusedThreadId}
      renderLeaf={renderLeaf}
      onTreeChange={(next) => onTreeChange(next)}
    />
  );
}

function GridBranch({
  node,
  path,
  focusedThreadId,
  renderLeaf,
  onTreeChange,
}: {
  node: LayoutNode;
  path: number[];
  focusedThreadId: string | null;
  renderLeaf: (node: ThreadNode, focused: boolean) => ReactNode;
  onTreeChange: (tree: LayoutNode) => void;
}) {
  if (node.kind === "thread") {
    return <>{renderLeaf(node, node.threadId === focusedThreadId)}</>;
  }
  return (
    <SplitView
      node={node}
      path={path}
      focusedThreadId={focusedThreadId}
      renderLeaf={renderLeaf}
      onTreeChange={onTreeChange}
    />
  );
}

function SplitView({
  node,
  path,
  focusedThreadId,
  renderLeaf,
  onTreeChange,
}: {
  node: SplitNode;
  path: number[];
  focusedThreadId: string | null;
  renderLeaf: (node: ThreadNode, focused: boolean) => ReactNode;
  onTreeChange: (tree: LayoutNode) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    index: number;
    startCoord: number;
    spanPx: number;
    pairSum: number;
    startWeight: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const applyRatio = (index: number, clientCoord: number) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const deltaPx = clientCoord - drag.startCoord;
    const span = drag.spanPx - (node.children.length - 1) * GUTTER_PX;
    if (span <= 0) return;
    const ratio = clampSplitRatio((drag.startWeight + (deltaPx / span) * 100) / drag.pairSum, span);
    onTreeChange(setRatio(node, path, index, ratio));
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden",
        dragging && "select-none",
      )}
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
              focusedThreadId={focusedThreadId}
              renderLeaf={renderLeaf}
              onTreeChange={onTreeChange}
            />
          </div>
          {index < node.children.length - 1 ? (
            <div
              role="separator"
              aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
              aria-label="Resize grid cells"
              tabIndex={0}
              className={cn(
                "group relative z-10 shrink-0 bg-(--divider) outline-none transition-colors hover:bg-(--accent-ink) focus-visible:bg-(--accent-ink)",
                node.dir === "row"
                  ? "w-px cursor-col-resize before:absolute before:inset-y-0 before:-inset-x-1.5 before:content-['']"
                  : "h-px cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
              )}
              onDoubleClick={() => onTreeChange(setRatio(node, path, index, 0.5))}
              onPointerDown={(event) => {
                const container = containerRef.current;
                if (container === null) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const pairSum = (node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1;
                dragRef.current = {
                  index,
                  startCoord: node.dir === "row" ? event.clientX : event.clientY,
                  spanPx: node.dir === "row" ? container.clientWidth : container.clientHeight,
                  pairSum,
                  startWeight: node.weights[index] ?? 0,
                };
                setDragging(true);
              }}
              onPointerMove={(event) => {
                if (dragRef.current === null) return;
                applyRatio(index, node.dir === "row" ? event.clientX : event.clientY);
              }}
              onPointerUp={(event) => {
                dragRef.current = null;
                setDragging(false);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setDragging(false);
              }}
              onKeyDown={(event) => {
                const decrease = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
                const increase = node.dir === "row" ? "ArrowRight" : "ArrowDown";
                if (event.key !== decrease && event.key !== increase) return;
                event.preventDefault();
                const container = containerRef.current;
                const span =
                  (node.dir === "row" ? container?.clientWidth : container?.clientHeight) ?? 0;
                const pairSum = (node.weights[index] ?? 0) + (node.weights[index + 1] ?? 0) || 1;
                const current = (node.weights[index] ?? 0) / pairSum;
                const delta = event.key === increase ? 0.02 : -0.02;
                onTreeChange(
                  setRatio(node, path, index, clampSplitRatio(current + delta, Math.max(span, 1))),
                );
              }}
            ></div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
