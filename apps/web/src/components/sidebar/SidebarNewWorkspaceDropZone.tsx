import { useRef } from "react";

import {
  useThreadDragState,
  useThreadDropTarget,
  useThreadDropZone,
  type WorkspaceDragSource,
} from "../../threads/threadDrag";
import { SidebarNewWorkspaceDropArea } from "../ui/sidebar-sections";

/** The blank area that ends the workspace list: dropping a card or tab on it makes a workspace. */
export function SidebarNewWorkspaceDropZone({
  onDrop,
}: {
  onDrop: (source: WorkspaceDragSource) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const dragging = useThreadDragState() !== null;
  const over = useThreadDropTarget()?.kind === "new-workspace";
  useThreadDropZone(
    ref,
    () => ({ kind: "new-workspace" }),
    (source) => onDrop(source),
  );
  return <SidebarNewWorkspaceDropArea ref={ref} dragging={dragging} over={over} />;
}
