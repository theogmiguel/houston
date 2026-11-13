import type { PointerEvent as ReactPointerEvent } from "react";

import { endTabDrag, moveTabDrag, type TabDragSource } from "../threads/threadDrag";
import { cancelLayoutDrag, dropLayoutDrag, moveLayoutDrag } from "./layoutDrag";
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
  if (event.button !== 0 || event.pointerType === "touch") return;
  const start = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  const source = { kind: "tab", tabId } as const;
  const sidebarSource = tabDragSourceOf(tabId);
  let started = false;

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      started = true;
    }
    moveEvent.preventDefault();
    const point = { x: moveEvent.clientX, y: moveEvent.clientY };
    if (sidebarSource !== null && moveTabDrag(sidebarSource, point)) {
      cancelLayoutDrag();
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
    // The sidebar commits first: when a workspace had the pointer, the layout has no target.
    const sidebarTookIt = endTabDrag(drop);
    if (drop && !sidebarTookIt) dropLayoutDrag();
    else cancelLayoutDrag();
    // The release that ends a drag must not also open the tab's menu or focus it.
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
