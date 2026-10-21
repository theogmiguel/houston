import { lazy, Suspense } from "react";
import { basename } from "./editor/bufferStore";

const ContentSearch = lazy(() => import("./components/files/ContentSearch").then((module) => ({ default: module.ContentSearch })));
const QuickOpen = lazy(() => import("./components/files/QuickOpen").then((module) => ({ default: module.QuickOpen })));

interface QuickOpenOverlayProps {
  open: boolean;
  workspace: string;
  onClose: () => void;
  onOpen: (path: string) => void;
}

export function QuickOpenOverlay({ open, workspace, onClose, onOpen }: QuickOpenOverlayProps): React.JSX.Element | null {
  if (!open || workspace === "all") return null;
  return (
    <Suspense fallback={null}>
      <QuickOpen root={workspace} workspaceName={basename(workspace)} onClose={onClose} onOpen={onOpen} />
    </Suspense>
  );
}

interface ContentSearchOverlayProps {
  open: boolean;
  workspace: string;
  onClose: () => void;
  onOpen: (path: string, line: number, column: number) => void;
}

export function ContentSearchOverlay({ open, workspace, onClose, onOpen }: ContentSearchOverlayProps): React.JSX.Element | null {
  if (!open || workspace === "all") return null;
  return (
    <Suspense fallback={null}>
      <ContentSearch
        root={workspace}
        workspaceName={basename(workspace)}
        onClose={onClose}
        onOpen={(path, line, column) => onOpen(`${workspace}/${path}`, line, column)}
      />
    </Suspense>
  );
}
