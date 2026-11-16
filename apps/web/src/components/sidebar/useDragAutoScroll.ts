import { useEffect, type RefObject } from "react";

import { getThreadDragPoint, useThreadDragState } from "../../threads/threadDrag";
import { dragAutoScrollStep } from "../../threads/workspaceDrop";

function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  for (let node = element; node !== null; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Scrolls the list that holds `contentRef` while a card or tab drag has the pointer near its top
 * or bottom edge, so workspaces past the fold stay reachable.
 */
export function useDragAutoScroll(contentRef: RefObject<HTMLElement | null>): void {
  const dragging = useThreadDragState() !== null;
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- runs a frame loop for the length of a drag
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const point = getThreadDragPoint();
      const scroller = scrollerOf(contentRef.current);
      if (point !== null && scroller !== null) {
        const rect = scroller.getBoundingClientRect();
        if (point.x >= rect.left && point.x <= rect.right) {
          const step = dragAutoScrollStep(point.y, rect);
          if (step !== 0) scroller.scrollTop += step;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, contentRef]);
}
