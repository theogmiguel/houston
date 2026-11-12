/** The workspace operations of `layoutWorkspaces` applied to the layout store. Each returns the refusal text, or null when it applied. */
import type { LayoutState } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  createLayoutWorkspaceNamed,
  deleteLayoutWorkspace,
  moveLayoutWorkspaceById,
  renameLayoutWorkspaceChecked,
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
  store.commitDerived(before, next, (layout) => moveLayoutWorkspaceById(layout, workspaceId, delta));
}
