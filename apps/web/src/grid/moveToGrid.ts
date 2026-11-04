import {
  type GridRecord,
  gridById,
  MAX_GRID_THREADS,
  orderedGridsForWorkspace,
  useGridStore,
  workspaceKeyOf,
} from "./gridStore";
import { gridFullMoveToast, type ProjectOwner } from "./projectMove";
import { preorderThreads } from "./tree";

export interface MoveToGridTarget {
  readonly gridId: string;
  readonly name: string;
}

/** The project's other visible grids, by name, for the Move to grid menu. */
export function moveToGridTargets(
  grids: readonly GridRecord[],
  input: ProjectOwner & { readonly currentGridId: string | null },
): MoveToGridTarget[] {
  return orderedGridsForWorkspace(grids, workspaceKeyOf(input.environmentId, input.projectId))
    .filter((grid) => !grid.hidden && grid.id !== input.currentGridId)
    .map((grid) => ({ gridId: grid.id, name: grid.name }));
}

/**
 * Moves a thread into another grid of its project. A refused move returns the
 * toast that explains it, so no caller drops the refusal silently.
 */
export function moveThreadToGridOrExplain(input: {
  readonly threadId: string;
  readonly threadEnvironmentId: string;
  readonly threadProjectId: string;
  readonly targetGridId: string;
}): { title: string; description: string } | null {
  if (useGridStore.getState().moveThreadToGrid(input)) return null;
  const target = gridById(useGridStore.getState().grids, input.targetGridId);
  const shown = target?.tree == null ? 0 : preorderThreads(target.tree).length;
  return gridFullMoveToast(target?.name ?? input.targetGridId, shown, MAX_GRID_THREADS);
}
