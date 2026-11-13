import { createPortal } from "react-dom";

import { isTabDragSource, useThreadDragPoint, useThreadDragState } from "~/threads/threadDrag";

/**
 * Covers the window while a thread drag is live: it keeps a terminal, browser
 * surface or iframe from swallowing pointer moves and suppresses text selection.
 * A dragged card's title follows the pointer above every drop zone; a dragged
 * tab brings its own copy.
 */
export function ThreadDragOverlay() {
  const state = useThreadDragState();
  const point = useThreadDragPoint();
  if (state === null) return null;
  const title = isTabDragSource(state.source) ? undefined : state.source.title;
  return createPortal(
    <>
      <div
        data-thread-drag-overlay=""
        aria-hidden
        className="fixed inset-0 z-50 cursor-grabbing select-none"
      />
      {title !== undefined && point !== null ? (
        <div
          data-thread-drag-ghost=""
          aria-hidden
          className="pointer-events-none fixed top-0 left-0 z-[95] flex h-8 max-w-48 items-center rounded-(--r-group) bg-(--raised) px-3 text-xs text-foreground shadow-[var(--shadow-1)]"
          style={{ transform: `translate(${point.x + 12}px, ${point.y + 10}px) rotate(-2deg)` }}
        >
          <span className="min-w-0 truncate">{title}</span>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
