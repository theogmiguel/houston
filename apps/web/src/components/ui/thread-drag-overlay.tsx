import { createPortal } from "react-dom";

import { useThreadDragState } from "~/grid/threadDrag";

/**
 * Covers the window while a thread drag is live: it keeps a terminal, browser
 * surface or iframe from swallowing pointer moves and suppresses text selection.
 */
export function ThreadDragOverlay() {
  const dragging = useThreadDragState() !== null;
  if (!dragging) return null;
  return createPortal(
    <div
      data-thread-drag-overlay=""
      aria-hidden
      className="fixed inset-0 z-50 cursor-grabbing select-none"
    />,
    document.body,
  );
}
