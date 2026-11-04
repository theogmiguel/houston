import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { gridById, useGridStore } from "./gridStore";
import { moveThreadToGridOrExplain } from "./moveToGrid";

export interface ThreadMoveFeedback {
  readonly threadId: string;
  readonly threadEnvironmentId: string;
  readonly threadProjectId: string;
  readonly threadTitle: string | null;
  /** The grid the thread left; null when no grid showed it. */
  readonly sourceGridId: string | null;
  readonly targetGridId: string;
  readonly onOpenTarget: (gridId: string) => void;
}

/**
 * A move that happened in the sidebar does not take the user with it: the
 * toast offers the target grid and the way back. Undo is a move, so a grid that
 * filled up in the meantime refuses it with the same explanation.
 */
export function showThreadMovedToast(input: ThreadMoveFeedback): void {
  const target = gridById(useGridStore.getState().grids, input.targetGridId);
  const targetName = target?.name ?? "the grid";
  const named = input.threadTitle === null ? "The thread" : `“${input.threadTitle}”`;
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Moved to “${targetName}”`,
      description: `${named} is now in “${targetName}”.`,
      data: {
        secondaryActionVariant: "outline",
        additionalActions: [
          {
            id: "open",
            props: {
              children: `Open ${targetName}`,
              onClick: () => input.onOpenTarget(input.targetGridId),
            },
          },
          {
            id: "undo",
            props: {
              children: "Undo",
              onClick: () => undoThreadMove(input),
            },
          },
        ],
      },
    }),
  );
}

export function undoThreadMove(input: ThreadMoveFeedback): void {
  if (input.sourceGridId !== null && input.sourceGridId !== input.targetGridId) {
    const refusal = moveThreadToGridOrExplain({
      threadId: input.threadId,
      threadEnvironmentId: input.threadEnvironmentId,
      threadProjectId: input.threadProjectId,
      targetGridId: input.sourceGridId,
    });
    if (refusal !== null) toastManager.add(stackedThreadToast({ type: "error", ...refusal }));
    return;
  }
  // No grid showed it before: back to the ungrouped list.
  useGridStore.getState().removeThreadFromGrid(input.targetGridId, input.threadId);
}
