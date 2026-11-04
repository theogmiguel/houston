/**
 * FLIP motion for grid cells: measure each cell's box before a layout change,
 * then translate it from where it was to where it is now. Transform only, so
 * the compositor moves the card and WebKitGTK never repaints a resized cell
 * mid-animation.
 */
import { probeCellMoveFrames } from "./frameProbe";
import { useLayoutEffect, useRef, type RefObject } from "react";

import { MotionAnimation, playMotion, toDevicePixel, type MotionRun } from "./animation";

export interface CellPosition {
  readonly element: HTMLElement;
  readonly x: number;
  readonly y: number;
}

interface Running {
  readonly run: MotionRun;
  readonly dx: number;
  readonly dy: number;
}

const runs = new WeakMap<HTMLElement, Running>();
/** How many cells of each surface are mid-move; the surface clips only when none are. */
const flipping = new WeakMap<HTMLElement, number>();

function markFlipping(root: HTMLElement, delta: 1 | -1): void {
  const next = Math.max(0, (flipping.get(root) ?? 0) + delta);
  if (next === 0) {
    flipping.delete(root);
    delete root.dataset.flipping;
    return;
  }
  flipping.set(root, next);
  // A moving cell leaves its slot; the surface and its slots must not clip it.
  root.dataset.flipping = "";
}

/** The cell's offset inside `root`'s layout box, ignoring any transform in flight. */
export function offsetWithin(element: HTMLElement, root: HTMLElement): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = element;
  while (node !== null && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === root ? { x, y } : null;
}

/** Every cell of the surface, keyed by thread id. Measurement only reads layout. */
export function measureCells(root: HTMLElement): Map<string, CellPosition> {
  const cells = new Map<string, CellPosition>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-grid-cell][data-thread-id]")) {
    const threadId = element.dataset.threadId;
    if (threadId === undefined || threadId.length === 0) continue;
    const offset = offsetWithin(element, root);
    if (offset === null) continue;
    cells.set(threadId, { element, x: offset.x, y: offset.y });
  }
  return cells;
}

/** Stops the moves a previous grid left running. */
export function cancelCellMoves(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-grid-cell][data-thread-id]")) {
    const running = runs.get(element);
    if (running === undefined) continue;
    running.run.cancel();
    runs.delete(element);
    element.style.transform = "";
    markFlipping(root, -1);
  }
}

/**
 * Moves every cell that existed before into place. A cell already moving starts
 * from where it shows now, so a drag retargeted mid-animation settles at the new
 * target instead of snapping back first.
 */
export function animateCellMove(
  root: HTMLElement,
  previous: ReadonlyMap<string, CellPosition>,
): void {
  let probedCells = 0;
  let probedMs = 0;
  for (const [threadId, now] of measureCells(root)) {
    const was = previous.get(threadId);
    if (was === undefined) continue;
    let dx = was.x - now.x;
    let dy = was.y - now.y;
    const running = runs.get(now.element);
    if (running !== undefined) {
      const progress = running.run.value();
      dx += running.dx * progress;
      dy += running.dy * progress;
      running.run.cancel();
      runs.delete(now.element);
    }
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    const motion = MotionAnimation.start("grid-cell-movement", 1, 0);
    if (motion.durationMs <= 0) continue;
    const keyframe = (progress: number): Keyframe => ({
      transform: `translate(${toDevicePixel(dx * progress)}px, ${toDevicePixel(dy * progress)}px)`,
    });
    probedCells += 1;
    probedMs = Math.max(probedMs, motion.durationMs);
    markFlipping(root, 1);
    const entry: Running = {
      dx,
      dy,
      run: playMotion(now.element, motion, keyframe, () => {
        markFlipping(root, -1);
        if (runs.get(now.element) !== entry) return;
        runs.delete(now.element);
        now.element.style.transform = "";
      }),
    };
    runs.set(now.element, entry);
  }
  probeCellMoveFrames(probedCells, probedMs);
}

/**
 * Runs the FLIP for a grid surface. `layoutKey` is any value that changes with
 * the tree; `enabled` is false while cells grow in or shrink away, because the
 * grid's own flex transition already animates those.
 */
export function useGridCellFlip(
  rootRef: RefObject<HTMLElement | null>,
  gridId: string,
  layoutKey: unknown,
  enabled: boolean,
): void {
  const previous = useRef<{ gridId: string; cells: Map<string, CellPosition> } | null>(null);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- measures committed cell boxes and starts their transform animations before paint
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a ref object is stable; its current must not retrigger the effect
    const root = rootRef.current;
    if (root === null) {
      previous.current = null;
      return;
    }
    if (previous.current === null || previous.current.gridId !== gridId) {
      cancelCellMoves(root);
      previous.current = { gridId, cells: measureCells(root) };
      return;
    }
    if (enabled) animateCellMove(root, previous.current.cells);
    previous.current = { gridId, cells: measureCells(root) };
  }, [gridId, layoutKey, enabled]);
}
