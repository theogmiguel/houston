/** The workspace operations of `layoutWorkspaces` applied to the layout store. Each returns the refusal text, or null when it applied. */
import {
  createLayoutLauncherContent,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  createLayoutWorkspaceNamed,
  deleteLayoutWorkspace,
  moveLayoutChatToWorkspace,
  moveLayoutWorkspaceById,
  renameLayoutWorkspaceChecked,
  reorderLayoutWorkspace,
  setLayoutWorkspaceHidden,
  setLayoutWorkspacePinned,
  type WorkspaceResult,
} from "./layoutWorkspaces";

function applyWorkspaceChange(change: (layout: LayoutState) => WorkspaceResult): string | null {
  const store = useLayoutStore.getState();
  const before = store.layout;
  const result = change(before);
  if (result.refusal !== null) return result.refusal;
  store.commitDerived(before, result.state, (layout) => change(layout).state);
  return null;
}

export function createLayoutWorkspaceAction(name: string): string | null {
  return applyWorkspaceChange((layout) => createLayoutWorkspaceNamed(layout, name));
}

export function renameLayoutWorkspaceAction(workspaceId: string, name: string): string | null {
  return applyWorkspaceChange((layout) => renameLayoutWorkspaceChecked(layout, workspaceId, name));
}

export function deleteLayoutWorkspaceAction(workspaceId: string): string | null {
  return applyWorkspaceChange((layout) => deleteLayoutWorkspace(layout, workspaceId));
}

export function moveLayoutWorkspaceAction(workspaceId: string, delta: 1 | -1): void {
  const store = useLayoutStore.getState();
  const before = store.layout;
  const next = moveLayoutWorkspaceById(before, workspaceId, delta);
  if (next === before) return;
  store.commitDerived(before, next, (layout) =>
    moveLayoutWorkspaceById(layout, workspaceId, delta),
  );
}

export function pinLayoutWorkspaceAction(workspaceId: string, pinned: boolean): void {
  const now = new Date().toISOString();
  applyWorkspaceChange((layout) => ({
    state: setLayoutWorkspacePinned(layout, workspaceId, pinned, now),
    refusal: null,
  }));
}

export function hideLayoutWorkspaceAction(workspaceId: string, hidden: boolean): void {
  applyWorkspaceChange((layout) => ({
    state: setLayoutWorkspaceHidden(layout, workspaceId, hidden),
    refusal: null,
  }));
}

export function reorderLayoutWorkspaceAction(
  workspaceId: string,
  targetId: string,
  side: "before" | "after",
): void {
  applyWorkspaceChange((layout) => ({
    state: reorderLayoutWorkspace(layout, workspaceId, targetId, side),
    refusal: null,
  }));
}

/** Move a thread's chat to a workspace without moving the user; returns the refusal text, or null. */
export function moveLayoutChatToWorkspaceAction(
  content: Extract<LayoutTabContent, { kind: "chat" }>,
  workspaceId: string,
): string | null {
  return applyWorkspaceChange((layout) => moveLayoutChatToWorkspace(layout, content, workspaceId));
}

/** Open a launcher tab at the end of a workspace and go there, to start a thread in it. */
export function openLayoutLauncherInWorkspaceAction(workspaceId: string): void {
  const store = useLayoutStore.getState();
  const workspace = store.layout.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return;
  store.placeContent(createLayoutLauncherContent(null), {
    kind: "column",
    workspaceId,
    index: workspace.columns.length,
  });
}
