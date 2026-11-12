/**
 * The way back for a closed tab: a button that reopens the most recent one, and the notice shown
 * when there is nothing to reopen or the reopen failed. The reopen itself is the caller's, since
 * placing a view back needs its thread, its panels and the route.
 */
import { Undo2Icon } from "lucide-react";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { useClosedViewStore } from "../closedViewStore";
import { cn } from "../lib/utils";

/** How many closed tabs wait to be reopened. */
export function useClosedTabCount(): number {
  return useClosedViewStore((state) => state.entries.length);
}

/**
 * Reopen the most recent closed tab through `reopen`, which resolves false when it could not.
 * Says so when there was nothing to reopen or the reopen failed.
 */
export async function reopenClosedTab(reopen: () => Promise<boolean> | boolean): Promise<boolean> {
  if (useClosedViewStore.getState().entries.length === 0) {
    toastManager.add({
      type: "info",
      title: "Nothing to reopen",
      description: "Close a tab and it can be reopened from here.",
    });
    return false;
  }
  try {
    if (await reopen()) return true;
    toastManager.add({
      type: "error",
      title: "Could not reopen the tab",
      description: "Its thread or workspace is no longer available.",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not reopen the tab",
      description: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

export interface ClosedTabRestoreButtonProps {
  readonly reopen: () => Promise<boolean> | boolean;
  readonly className?: string;
}

/** Stays in place with nothing to reopen, and says why when pressed. */
export function ClosedTabRestoreButton({ reopen, className }: ClosedTabRestoreButtonProps) {
  const count = useClosedTabCount();
  return (
    <Button
      variant="ghost-muted"
      size="xs"
      aria-disabled={count === 0 ? true : undefined}
      data-layout-reopen-closed=""
      className={cn(className)}
      onClick={() => void reopenClosedTab(reopen)}
    >
      <Undo2Icon aria-hidden />
      Reopen closed tab
    </Button>
  );
}
