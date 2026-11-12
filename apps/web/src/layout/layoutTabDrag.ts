import type { PointerEvent as ReactPointerEvent } from "react";

import { cancelLayoutDrag, dropLayoutDrag, moveLayoutDrag } from "./layoutDrag";
import { countLayoutTabs } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

/** Pointer travel before a press on a tab becomes a drag, so clicks keep working. */
const DRAG_THRESHOLD = 6;

/**
 * Start dragging a tab on a press that travels past the threshold. Below it the press stays a
 * click (menus, rename, focus). Once dragging, the click that ends the gesture is swallowed and
 * Escape cancels.
 */
export function beginLayoutTabDrag(event: ReactPointerEvent, tabId: string): void {
  if (event.button !== 0 || event.pointerType === "touch") return;
  // A lone tab has nowhere to go.
  if (countLayoutTabs(useLayoutStore.getState().layout) < 2) return;
  const start = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  const source = { kind: "tab", tabId } as const;
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
    moveLayoutDrag(source, { x: moveEvent.clientX, y: moveEvent.clientY });
  };
  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!started) return;
    if (drop) dropLayoutDrag();
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
