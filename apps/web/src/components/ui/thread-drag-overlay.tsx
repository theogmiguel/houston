import { MessagesSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { LayoutDragGhost } from "./layout-pane";

import { useThreadContextDragGhost } from "~/components/chat/threadContextDrag";
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
  // Over the panes and composers the context drag draws the chip; this one covers the sidebar.
  const contextGhost = useThreadContextDragGhost();
  if (state === null) return null;
  const title = isTabDragSource(state.source) ? undefined : state.source.title;
  return createPortal(
    <>
      <div
        data-thread-drag-overlay=""
        aria-hidden
        className="fixed inset-0 z-50 cursor-grabbing select-none"
      />
      {title !== undefined && point !== null && contextGhost === null ? (
        <LayoutDragGhost data-thread-drag-ghost="" point={point}>
          <MessagesSquareIcon className="size-3.5 shrink-0 text-secondary-label" />
          <span className="min-w-0 truncate">{title}</span>
        </LayoutDragGhost>
      ) : null}
    </>,
    document.body,
  );
}
