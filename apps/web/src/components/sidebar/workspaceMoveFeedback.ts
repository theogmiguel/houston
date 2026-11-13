import {
  createEmptyWorkspaceOnServer,
  moveThreadToWorkspaceOnServer,
  type ThreadRef,
} from "../../layout/threadWorkspaceCommands";
import type { HoustonLayoutThreadMoveResult } from "@houston-app/contracts/houston/layoutWorkspaces";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface ThreadWorkspaceMove {
  readonly thread: ThreadRef;
  readonly threadTitle: string | null;
  /** An existing workspace, or `newWorkspace` to make one for the thread first. */
  readonly target: { readonly workspaceId: string; readonly name: string } | "new-workspace";
  /** The name of a workspace the window shows, for the toast and a refused undo. */
  readonly nameOf: (workspaceId: string) => string;
  readonly onOpenTarget: (workspaceId: string) => void;
  /**
   * Set when the window already placed the thread's tab in the target (a drop on a pane), so
   * only the toast and the way back to `previous` remain.
   */
  readonly placed?: { readonly previous: HoustonLayoutThreadMoveResult["previous"] };
}

function explain(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Moves a thread, its children and their open tabs to another workspace without taking the user
 * along, then offers the workspace and the way back. A refused move explains itself, leaves the
 * thread where it was and reports false.
 */
export async function moveThreadToWorkspaceWithFeedback(
  move: ThreadWorkspaceMove,
): Promise<boolean> {
  let target: { workspaceId: string; name: string };
  let previous: HoustonLayoutThreadMoveResult["previous"];
  try {
    if (move.target === "new-workspace") {
      const created = await createEmptyWorkspaceOnServer();
      target = { workspaceId: created.id, name: created.name };
    } else {
      target = move.target;
    }
    previous =
      move.placed?.previous ??
      (
        await moveThreadToWorkspaceOnServer({
          thread: move.thread,
          workspaceId: target.workspaceId,
        })
      ).previous;
  } catch (error) {
    explain("Cannot move this thread", messageOf(error));
    return false;
  }
  const named = move.threadTitle === null ? "The thread" : `“${move.threadTitle}”`;
  const undo =
    previous.workspaceId === null
      ? []
      : [
          {
            id: "undo",
            props: {
              children: "Undo",
              onClick: () => {
                void moveThreadToWorkspaceOnServer({
                  thread: move.thread,
                  workspaceId: previous.workspaceId!,
                  paneId: previous.paneId,
                  index: previous.index,
                }).catch((error: unknown) =>
                  explain(
                    `Cannot move back to “${move.nameOf(previous.workspaceId!)}”`,
                    messageOf(error),
                  ),
                );
              },
            },
          },
        ];
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Moved to “${target.name}”`,
      description: `${named} is now in “${target.name}”.`,
      data: {
        secondaryActionVariant: "outline",
        additionalActions: [
          {
            id: "open",
            props: {
              children: "Open",
              "aria-label": `Open ${target.name}`,
              onClick: () => move.onOpenTarget(target.workspaceId),
            },
          },
          ...undo,
        ],
      },
    }),
  );
  return true;
}
