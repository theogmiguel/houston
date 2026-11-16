import { NEW_WORKSPACE_DROP } from "../threads/workspaceDrop";
import { findLayoutPane } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

/**
 * Moves a tab that holds no server thread (a draft, terminal or page) to a workspace, into its
 * focused pane, or into a workspace made for it. The visible workspace stays visible. A chat with
 * a server thread moves with its thread instead, through the server.
 */
export function moveTabToWorkspaceDrop(tabId: string, target: string): void {
  const store = useLayoutStore.getState();
  const before = store.layout;
  if (target === NEW_WORKSPACE_DROP) {
    store.moveTabToNewWorkspace(tabId, before.workspaces.length);
  } else {
    const workspace = before.workspaces.find((candidate) => candidate.id === target);
    if (workspace === undefined) {
      throw new Error(
        `Cannot move tab '${tabId}': workspace '${target}' is not in the layout (${before.workspaces.length} workspaces).`,
      );
    }
    const found =
      workspace.focusedPaneId === null ? null : findLayoutPane(before, workspace.focusedPaneId);
    store.moveTab(
      tabId,
      found === null
        ? { kind: "column", workspaceId: workspace.id, index: workspace.columns.length }
        : { kind: "pane", paneId: found.pane.id },
    );
  }
  const stayOn = before.focusedWorkspaceId;
  const after = useLayoutStore.getState().layout;
  if (after.focusedWorkspaceId !== stayOn && after.workspaces.some((w) => w.id === stayOn)) {
    useLayoutStore.getState().focusWorkspace(stayOn);
  }
}
