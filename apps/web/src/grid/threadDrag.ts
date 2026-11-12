import { suppressTextSelection } from "../lib/suppressTextSelection";
import {
  useEffect,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@houston-app/contracts";

import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
} from "../components/chat/threadContextDrag";
import { useStableCallback } from "../hooks/useStableCallback";
import type { ThreadDropRefusal } from "./projectMove";
import type { Side } from "@houston-app/shared/grid/tree";

/** The thread a drag carries: a sidebar row, a grid cell label or a menu move. */
export interface ThreadDragSource {
  /** The grid the thread currently lives in; null for a thread no grid shows. */
  readonly gridId: string | null;
  /** The layout workspace showing the thread's chat; a sidebar row sets it, a grid cell does not. */
  readonly workspaceId?: string | null;
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
  /**
   * The thread's title. A source that has one can also be dropped on a chat composer, which takes
   * the thread as context; a source without one only moves within the grids.
   */
  readonly title?: string;
}

/** What a live drag would do if it ended under the pointer. */
export type ThreadDropTarget =
  | {
      readonly kind: "cell";
      readonly gridId: string;
      readonly threadId: string;
      readonly side: Side;
      readonly refusal: ThreadDropRefusal | null;
    }
  | { readonly kind: "grid"; readonly gridId: string }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "thread"; readonly gridId: string | null; readonly threadId: string }
  | { readonly kind: "closed" };

export interface ThreadDragState {
  readonly source: ThreadDragSource;
  readonly target: ThreadDropTarget | null;
}

export interface ThreadDragPoint {
  readonly x: number;
  readonly y: number;
}

/** Pointer travel before a press becomes a drag, so a short press still clicks. */
const DRAG_THRESHOLD_PX = 6;

export interface ThreadDropZone {
  /** Read lazily: the zone's element can mount after the zone is registered. */
  getElement: () => HTMLElement | null;
  resolve: (point: ThreadDragPoint, source: ThreadDragSource) => ThreadDropTarget | null;
  drop: (source: ThreadDragSource, target: ThreadDropTarget) => void;
}

const zones = new Set<ThreadDropZone>();
const listeners = new Set<() => void>();
let state: ThreadDragState | null = null;
let activeZone: ThreadDropZone | null = null;
let lastPoint: ThreadDragPoint | null = null;
let cancelGesture: (() => void) | null = null;
let releaseSelection: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function publish(next: ThreadDragState | null): void {
  if (state === next) return;
  state = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): ThreadDragState | null {
  return state;
}

/** The drag in flight, shared by the sidebar, every grid and the overlay. */
export function useThreadDragState(): ThreadDragState | null {
  return useSyncExternalStore(subscribe, getState, () => null);
}

export function useThreadDragSource(): ThreadDragSource | null {
  return useThreadDragState()?.source ?? null;
}

export function useThreadDropTarget(): ThreadDropTarget | null {
  return useThreadDragState()?.target ?? null;
}

export function getThreadDragSource(): ThreadDragSource | null {
  return state?.source ?? null;
}

/**
 * Register the element whose geometry decides where a drop lands. The zone is
 * read from the ref on each pointer move, so the element may mount later.
 */
export function useThreadDropZone(
  elementRef: RefObject<HTMLElement | null>,
  resolve: ThreadDropZone["resolve"],
  drop: ThreadDropZone["drop"],
): void {
  const stableResolve = useStableCallback(resolve);
  const stableDrop = useStableCallback(drop);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- adds and removes this component's zone from the drag registry
  useEffect(() => {
    const zone: ThreadDropZone = {
      getElement: () => elementRef.current,
      resolve: stableResolve,
      drop: stableDrop,
    };
    zones.add(zone);
    return () => {
      zones.delete(zone);
    };
  }, [elementRef, stableResolve, stableDrop]);
}

function contains(rect: DOMRect, point: ThreadDragPoint): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/** The smallest zone under the pointer that takes the drop. */
function resolveDrop(
  point: ThreadDragPoint,
  source: ThreadDragSource,
): { zone: ThreadDropZone; target: ThreadDropTarget } | null {
  let best: { zone: ThreadDropZone; target: ThreadDropTarget; area: number } | null = null;
  for (const zone of zones) {
    const element = zone.getElement();
    if (element === null) continue;
    const rect = element.getBoundingClientRect();
    if (!contains(rect, point)) continue;
    const target = zone.resolve(point, source);
    if (target === null) continue;
    const area = rect.width * rect.height;
    if (best === null || area < best.area) best = { zone, target, area };
  }
  return best === null ? null : { zone: best.zone, target: best.target };
}

function sameTarget(left: ThreadDropTarget | null, right: ThreadDropTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "cell") {
    return (
      right.kind === "cell" &&
      left.gridId === right.gridId &&
      left.threadId === right.threadId &&
      left.side === right.side &&
      left.refusal === right.refusal
    );
  }
  if (left.kind === "grid") return right.kind === "grid" && left.gridId === right.gridId;
  if (left.kind === "workspace") {
    return right.kind === "workspace" && left.workspaceId === right.workspaceId;
  }
  if (left.kind === "thread") {
    return (
      right.kind === "thread" && left.gridId === right.gridId && left.threadId === right.threadId
    );
  }
  return true;
}

function updateDrag(source: ThreadDragSource, point: ThreadDragPoint): void {
  const found = resolveDrop(point, source);
  activeZone = found?.zone ?? null;
  lastPoint = point;
  const target = found?.target ?? null;
  // Over no rail or grid target, a titled thread can still land on a chat composer.
  if (source.title !== undefined) {
    if (target === null) moveThreadContextDrag(point, { title: source.title, count: 1 });
    else endThreadContextDrag();
  }
  if (state !== null && sameTarget(state.target, target)) return;
  publish({ source, target });
}

function beginDragState(source: ThreadDragSource): void {
  // A press that travelled before the threshold may already have painted a
  // selection; a drag starts with none.
  releaseSelection?.();
  releaseSelection = suppressTextSelection(document.documentElement);
  publish({ source, target: null });
}

function endDragState(): void {
  activeZone = null;
  lastPoint = null;
  endThreadContextDrag();
  releaseSelection?.();
  releaseSelection = null;
  publish(null);
}

/**
 * The click a drag ends on must not also open the row or the cell label. The
 * listener is removed after the task in case the drop navigated away.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

interface Gesture {
  readonly start: ThreadDragPoint;
  dragging: boolean;
}

function trackGesture(
  source: ThreadDragSource,
  pointerId: number,
  start: ThreadDragPoint,
  started = false,
): void {
  const gesture: Gesture = { start, dragging: started };

  const move = (event: PointerEvent): void => {
    if (event.pointerId !== pointerId) return;
    if (!gesture.dragging) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      gesture.dragging = true;
      beginDragState(source);
    }
    event.preventDefault();
    updateDrag(source, { x: event.clientX, y: event.clientY });
  };

  const finish = (commit: boolean): void => {
    if (cancelGesture === null) return;
    cancelGesture = null;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!gesture.dragging) return;
    const zone = activeZone;
    const target = state?.target ?? null;
    const releasedAt = lastPoint;
    endDragState();
    if (commit && zone !== null && target !== null) zone.drop(source, target);
    else if (commit && source.title !== undefined && releasedAt !== null) {
      dropThreadContext(releasedAt, [
        scopeThreadRef(source.environmentId as EnvironmentId, source.threadId as ThreadId),
      ]);
    }
    swallowNextClick();
  };

  const up = (event: PointerEvent): void => {
    if (event.pointerId === pointerId) finish(true);
  };
  const cancel = (): void => finish(false);
  const key = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (gesture.dragging) {
      event.preventDefault();
      event.stopPropagation();
    }
    finish(false);
  };

  cancelGesture = () => finish(false);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}

/**
 * Start a drag from a press: below the threshold the press stays a click, so
 * focus, menus and double-click rename keep working.
 */
export function beginThreadDrag(
  event: ReactPointerEvent<HTMLElement>,
  source: ThreadDragSource,
): void {
  if (event.button !== 0 || event.pointerType === "touch") return;
  if (cancelGesture !== null) return;
  trackGesture(source, event.pointerId, { x: event.clientX, y: event.clientY });
}

/** Start a drag that is already past the threshold, for tests and captures. */
export function beginThreadDragAt(
  source: ThreadDragSource,
  point: ThreadDragPoint,
  pointerId = 0,
): void {
  if (cancelGesture !== null) return;
  beginDragState(source);
  updateDrag(source, point);
  trackGesture(source, pointerId, point, true);
}

/** Cancel the drag in flight; the drop target gets nothing. */
export function endThreadDrag(): void {
  if (cancelGesture !== null) {
    cancelGesture();
    return;
  }
  if (state !== null) endDragState();
}
