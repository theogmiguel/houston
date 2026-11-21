import { create } from "zustand";

import { createLayoutWorkspaceAction, deleteLayoutWorkspaceAction } from "./layoutWorkspaceActions";
import { useLayoutStore } from "./layoutStore";
import { nextDefaultWorkspaceName } from "./layoutWorkspaces";

/** The workspace a "New workspace" action just created, whose rail heading opens to be named. */
export const useNewWorkspaceNamingStore = create<{ workspaceId: string | null }>()(() => ({
  workspaceId: null,
}));

/**
 * Create a workspace under the next default name, focus it, and ask the rail to open its name for
 * editing. Returns the refusal text, or null when it was created.
 */
export function startNewWorkspaceAction(): string | null {
  const refusal = createLayoutWorkspaceAction(
    nextDefaultWorkspaceName(useLayoutStore.getState().layout),
  );
  if (refusal !== null) return refusal;
  useNewWorkspaceNamingStore.setState({
    workspaceId: useLayoutStore.getState().layout.focusedWorkspaceId,
  });
  return null;
}

/** The new workspace has its name; the rail stops asking for one. */
export function finishNewWorkspaceNaming(): void {
  useNewWorkspaceNamingStore.setState({ workspaceId: null });
}

/** Escape on the new workspace's name takes the creation back; the last workspace stays. */
export function undoNewWorkspace(workspaceId: string): void {
  finishNewWorkspaceNaming();
  deleteLayoutWorkspaceAction(workspaceId);
}
