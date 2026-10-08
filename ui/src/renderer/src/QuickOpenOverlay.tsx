import { lazy, Suspense } from "react";
import { basename } from "./editor/bufferStore";

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
