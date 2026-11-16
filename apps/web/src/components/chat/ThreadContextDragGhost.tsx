import { MessagesSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { LayoutDragGhost } from "../ui/layout-pane";
import { useThreadContextDragGhost } from "./threadContextDrag";

export function ThreadContextDragGhost() {
  const ghost = useThreadContextDragGhost();
  if (ghost === null) return null;
  return createPortal(
    <LayoutDragGhost data-thread-context-drag-ghost="" point={ghost}>
      <MessagesSquareIcon className="size-3.5 shrink-0 text-secondary-label" />
      <span className="min-w-0 truncate">{ghost.title}</span>
      {ghost.count > 1 ? (
        <span className="shrink-0 text-secondary-label">+{ghost.count - 1}</span>
      ) : null}
    </LayoutDragGhost>,
    document.body,
  );
}
