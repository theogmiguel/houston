import type { LayoutTabContent } from "../../layout/layoutModel";
import { moveLayoutChatToWorkspaceAction } from "../../layout/layoutWorkspaceActions";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type ChatContent = Extract<LayoutTabContent, { kind: "chat" }>;

export interface ThreadWorkspaceMove {
  readonly content: ChatContent;
  readonly threadTitle: string | null;
  readonly source: { readonly workspaceId: string; readonly name: string };
  readonly target: { readonly workspaceId: string; readonly name: string };
  readonly onOpenTarget: (workspaceId: string) => void;
}

function explain(title: string, description: string): void {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/**
 * Moves a thread's chat to another workspace without taking the user along, then offers the
 * workspace and the way back. A refused move explains itself and reports false.
 */
export function moveThreadToWorkspaceWithFeedback(move: ThreadWorkspaceMove): boolean {
  const refusal = moveLayoutChatToWorkspaceAction(move.content, move.target.workspaceId);
  if (refusal !== null) {
    explain("Cannot move this thread", refusal);
    return false;
  }
  const named = move.threadTitle === null ? "The thread" : `“${move.threadTitle}”`;
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: `Moved to “${move.target.name}”`,
      description: `${named} is now in “${move.target.name}”.`,
      data: {
        secondaryActionVariant: "outline",
        additionalActions: [
          {
            id: "open",
            props: {
              children: `Open ${move.target.name}`,
              onClick: () => move.onOpenTarget(move.target.workspaceId),
            },
          },
          {
            id: "undo",
            props: {
              children: "Undo",
              onClick: () => {
                const undoRefusal = moveLayoutChatToWorkspaceAction(
                  move.content,
                  move.source.workspaceId,
                );
                if (undoRefusal !== null)
                  explain(`Cannot move back to “${move.source.name}”`, undoRefusal);
              },
            },
          },
        ],
      },
    }),
  );
  return true;
}
