import { lazy, Suspense } from "react";
import { basename } from "./editor/bufferStore";

const QuickOpen = lazy(() => import("./components/files/QuickOpen").then((module) => ({ default: module.QuickOpen })));

interface QuickOpenOverlayProps {
  open: boolean;
  workspace: string;
  onClose: () => void;
  onOpen: (path: string) => void;
}

// Search results are relative to the workspace; the editor needs an absolute path.
function workspaceFilePath(workspace: string, path: string): string {
  return `${workspace.replace(/[\\/]+$/, "")}/${path}`;
}

export function QuickOpenOverlay({ open, workspace, onClose, onOpen }: QuickOpenOverlayProps): React.JSX.Element | null {
  if (!open || workspace === "all") return null;
  return (
    <Suspense fallback={null}>
      <QuickOpen root={workspace} workspaceName={basename(workspace)} onClose={onClose} onOpen={(path) => onOpen(workspaceFilePath(workspace, path))} />
    </Suspense>
  );
}
