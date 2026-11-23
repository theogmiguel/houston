import type { PointerEvent as ReactPointerEvent } from "react";

import {
  dropThreadContext,
  endThreadContextDrag,
  findThreadContextDropTarget,
  listThreadContextDropTargets,
  moveThreadContextDrag,
} from "../components/chat/threadContextDrag";
import { endTabDrag, moveTabDrag, type TabDragSource } from "../threads/threadDrag";
import {
  cancelLayoutDrag,
  dropLayoutDrag,
  moveLayoutDrag,
  type LayoutDragSource,
} from "./layoutDrag";
import { findLayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

/** Pointer travel before a press on a tab becomes a drag, so clicks keep working. */
const DRAG_THRESHOLD = 6;

/** What the sidebar needs to know about the dragged tab: where it sits and which thread it shows. */
function tabDragSourceOf(tabId: string): TabDragSource | null {
  const location = findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === tabId);
  if (location === null) return null;
  const content = location.tab.content;
  const thread =
    content.kind === "chat" && content.target.kind === "server"
      ? {
          environmentId: content.target.threadRef.environmentId as string,
          threadId: content.target.threadRef.threadId as string,
        }
      : null;
  return { tabId, workspaceId: location.workspace.id, thread, title: null };
}

/**
 * Start dragging a tab on a press that travels past the threshold. Below it the press stays a
 * click (menus, rename, focus). Once dragging, the click that ends the gesture is swallowed and
 * Escape cancels. Over a sidebar workspace the sidebar takes the drag; elsewhere the layout's
 * pane targets do.
 */
export function beginLayoutTabDrag(event: ReactPointerEvent, tabId: string): void {
  beginLayoutPointerDrag(event, { kind: "tab", tabId }, tabDragSourceOf(tabId));
}

/**
 * Start dragging content that has no tab yet, such as the `+` button's launcher, with the same
 * gesture rules as a tab: the layout's pane targets take it and nothing else does.
 */
export function beginLayoutContentDrag(
  event: ReactPointerEvent,
  source: Extract<LayoutDragSource, { kind: "content" }>,
): void {
  beginLayoutPointerDrag(event, source, null);
}

/**
 * Start dragging a thread from a control that shows it (a context chip). A chat composer under
 * the pointer takes it as context; elsewhere the layout's pane targets open its chat.
 */
export function beginLayoutThreadDrag(
  event: ReactPointerEvent,
  source: Extract<LayoutDragSource, { kind: "thread" }>,
  options: { onStart?: () => void } = {},
): void {
  beginLayoutPointerDrag(event, source, null, options.onStart);
}

function beginLayoutPointerDrag(
  event: ReactPointerEvent,
  source: LayoutDragSource,
  sidebarSource: TabDragSource | null,
  onStart?: () => void,
): void {
  if (event.button !== 0 || event.pointerType === "touch") return;
  const start = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  let started = false;
  let last = start;

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      started = true;
      onStart?.();
    }
    moveEvent.preventDefault();
    const point = { x: moveEvent.clientX, y: moveEvent.clientY };
    last = point;
    if (source.kind === "thread") {
      moveThreadContextDrag(point, { title: source.title ?? "Thread", count: 1 });
      moveLayoutDrag(source, point, {
        composer: findThreadContextDropTarget(point),
        composerTargets: listThreadContextDropTargets(),
      });
      return;
    }
    if (sidebarSource !== null && moveTabDrag(sidebarSource, point)) {
      // The sidebar shows the destination; the layout keeps only the tab's chip on the pointer.
      moveLayoutDrag(source, point, { targetless: true });
      return;
    }
    moveLayoutDrag(source, point);
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!started) return;
    if (source.kind === "thread") {
      // The layout has no target while a composer has the pointer, so it commits first.
      const layoutTookIt = drop && dropLayoutDrag();
      endThreadContextDrag();
      cancelLayoutDrag();
      if (drop && !layoutTookIt) dropThreadContext(last, [source.threadRef]);
    } else {
      // The sidebar commits first: when a workspace had the pointer, the layout has no target.
      const sidebarTookIt = source.kind === "tab" && endTabDrag(drop);
      if (drop && !sidebarTookIt) dropLayoutDrag();
      else cancelLayoutDrag();
    }
    // The release that ends a drag must not also activate the control it started on.
    const swallow = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };
  const up = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) finish(true);
  };
  const cancel = () => finish(false);
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape" || !started) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
