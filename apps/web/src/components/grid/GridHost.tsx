import { LayoutGridIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { type GridRecord } from "../../grid/gridStore";
import {
  type LayoutNode,
  type SplitNode,
  type SplitSide,
  type ThreadNode,
  clampSplitRatio,
  insertBeside,
  MIN_PANE_PX,
  preorderThreads,
  removeThread,
  setRatio,
  threadLeaf,
} from "../../grid/tree";
import { cn } from "../../lib/utils";

export interface GridCellRenderProps {
  node: ThreadNode;
  focused: boolean;
  onClose: () => void;
  onSplit: (side: SplitSide, threadId: string) => void;
}

const GUTTER_PX = 0;

export interface GridHostProps {
  grid: GridRecord;
  onTreeChange: (tree: LayoutNode) => void;
  onFocusThread: (threadId: string) => void;
  renderThread: (cell: GridCellRenderProps) => ReactNode;
  renderEmpty?: () => ReactNode;
}

export function GridHost(props: GridHostProps) {
  const { grid, onTreeChange, onFocusThread, renderThread, renderEmpty } = props;
  const tree = grid.tree;

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
    const next = removeThread(tree, threadId);
    onTreeChange(next ?? tree);
  };

  const renderLeaf = (node: ThreadNode, focused: boolean): ReactNode =>
    renderThread({
      node,
      focused,
      onClose: () => closeThread(node.threadId),
      onSplit: (side, threadId) => splitThread(node.threadId, side, threadId),
    });

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
                minWidth: node.dir === "row" ? MIN_PANE_PX : undefined,
                minHeight: node.dir === "row" ? undefined : MIN_PANE_PX,
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
