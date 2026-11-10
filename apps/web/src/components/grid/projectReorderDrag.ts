import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { suppressTextSelection } from "../../lib/suppressTextSelection";

export type ProjectDropSide = "before" | "after";

export interface ProjectReorderDrag {
  readonly draggedKey: string;
  readonly targetKey: string | null;
  readonly side: ProjectDropSide;
}

/** Pointer travel before a press on a project row becomes a drag, so a short press still toggles it. */
const DRAG_THRESHOLD_PX = 6;

/** Marks a rail section that can be reordered; the scratch section carries no mark. */
export const PROJECT_REORDER_ATTRIBUTE = "data-project-reorder";

function targetUnderPointer(
  x: number,
  y: number,
  draggedKey: string,
): { key: string; side: ProjectDropSide } | null {
  for (const element of document.elementsFromPoint(x, y)) {
    const section = element.closest<HTMLElement>(`[${PROJECT_REORDER_ATTRIBUTE}]`);
    if (section === null) continue;
    const key = section.dataset.projectKey;
    if (key === undefined || key === draggedKey) return null;
    const rect = section.getBoundingClientRect();
    return { key, side: y < rect.top + rect.height / 2 ? "before" : "after" };
  }
  return null;
}

/**
 * Pointer-driven reordering of the rail's project sections. A press that moves
 * past the threshold becomes a drag; the drop calls `onDrop` with the section
 * under the pointer and which half of it the pointer is in.
 */
export function useProjectReorderDrag(
  onDrop: (draggedKey: string, targetKey: string, side: ProjectDropSide) => void,
): {
  drag: ProjectReorderDrag | null;
  begin: (event: ReactPointerEvent<HTMLElement>, projectKey: string) => void;
} {
  const [drag, setDrag] = useState<ProjectReorderDrag | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const stableDrop = useStableCallback(onDrop);

  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- cancels a gesture in flight when the rail unmounts
  useEffect(() => () => stopRef.current?.(), []);

  const begin = (event: ReactPointerEvent<HTMLElement>, projectKey: string) => {
    if (event.button !== 0 || event.pointerType === "touch" || stopRef.current !== null) return;
    const { pointerId, clientX: startX, clientY: startY } = event;
    let dragging = false;
    let published = false;
    let current: ProjectReorderDrag = { draggedKey: projectKey, targetKey: null, side: "before" };
    let releaseSelection: (() => void) | null = null;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragging) {
        if (
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        dragging = true;
        releaseSelection = suppressTextSelection(document.documentElement);
      }
      moveEvent.preventDefault();
      const hit = targetUnderPointer(moveEvent.clientX, moveEvent.clientY, projectKey);
      const next: ProjectReorderDrag = {
        draggedKey: projectKey,
        targetKey: hit?.key ?? null,
        side: hit?.side ?? "before",
      };
      if (published && next.targetKey === current.targetKey && next.side === current.side) return;
      published = true;
      current = next;
      setDrag(next);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      stopRef.current = null;
      releaseSelection?.();
      setDrag(null);
      if (!dragging) return;
      const swallow = (clickEvent: MouseEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
      if (commit && current.targetKey !== null) {
        stableDrop(projectKey, current.targetKey, current.side);
      }
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId === pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const key = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      if (dragging) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
      }
      finish(false);
    };

    stopRef.current = () => finish(false);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
  };

  return { drag, begin };
}
