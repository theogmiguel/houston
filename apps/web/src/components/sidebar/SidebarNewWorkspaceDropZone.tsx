import { useRef } from "react";

import {
  useThreadDragState,
  useThreadDropTarget,
  useThreadDropZone,
  type WorkspaceDragSource,
} from "../../threads/threadDrag";
import { SidebarNewWorkspaceDropRow } from "../ui/sidebar-sections";

/** The quiet row that ends the workspace list during a drag: dropping on it makes a workspace. */
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
  return dragging ? <SidebarNewWorkspaceDropRow ref={ref} over={over} /> : null;
}
