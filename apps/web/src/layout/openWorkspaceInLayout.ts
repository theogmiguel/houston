import { createLayoutWorkspaceAction } from "./layoutWorkspaceActions";
import { useLayoutStore } from "./layoutStore";

/**
 * Focuses a workspace; the route follows its focused tab. False when no workspace has the id, so
 * the caller can say so instead of leaving focus where it was.
 */
export function focusWorkspaceInLayout(workspaceId: string): boolean {
  const store = useLayoutStore.getState();
  if (!store.layout.workspaces.some((workspace) => workspace.id === workspaceId)) return false;
  store.focusWorkspace(workspaceId);
  return true;
}

/** Goes to the layout's empty workspace, named `name`, whose launcher starts what goes in it. */
export function openNewWorkspaceInLayout(name: string): string | null {
  return createLayoutWorkspaceAction(name);
}
