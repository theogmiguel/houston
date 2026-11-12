import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";

import { isSidebarHiddenThread } from "../components/Sidebar.logic";
import { readThreadShell } from "../state/entities";
import {
  gridContainingThread,
  MAX_GRID_THREADS,
  useGridStore,
  workspaceKeyOf,
} from "../grid/gridStore";
import { preorderThreads } from "@houston-app/shared/grid/tree";

/**
 * Places a thread started outside a grid in its workspace's grid, creating one if needed.
 * A subagent never gets a cell: it is skipped, and a parent whose cell it holds takes it back.
 */
export function ensureThreadPlaced(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly draftId?: string;
}): string | null {
  const store = useGridStore.getState();
  if (gridContainingThread(store.grids, input.environmentId, input.threadId) !== null) return null;
  const shell = readThreadShell(scopeThreadRef(input.environmentId, input.threadId));
  if (shell !== null && isSidebarHiddenThread(shell)) return null;
  const reclaimed = reclaimCellFromChild(input);
  if (reclaimed !== null) return reclaimed;
  // A detached thread returns to the grid and slot it left; a new grid would duplicate it.
  if (store.threadOrigins[input.threadId] !== undefined) return null;

  const pendingOwner = store.grids.find(
    (grid) =>
      grid.pendingDraft != null &&
      (grid.pendingDraft.threadId === input.threadId ||
        (input.draftId !== undefined && grid.pendingDraft.draftId === input.draftId)),
  );
  if (pendingOwner !== undefined) {
    store.addThread(pendingOwner.id, input.threadId);
    return pendingOwner.id;
  }

  const workspaceKey = workspaceKeyOf(input.environmentId, input.projectId);
  const workspaceGrids = store.grids.filter((grid) => grid.workspaceKey === workspaceKey);
  const threadCount = (grid: (typeof workspaceGrids)[number]) =>
    grid.tree === null ? 0 : preorderThreads(grid.tree).length;
  const hasRoom = (grid: (typeof workspaceGrids)[number]) => threadCount(grid) < MAX_GRID_THREADS;
  // An empty grid's own draft adds the thread there; prefer it so one grid keeps the thread.
  const empty = workspaceGrids
    .filter((grid) => grid.tree === null)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const existing =
    (empty !== undefined && hasRoom(empty) ? empty : undefined) ??
    workspaceGrids
      .filter(hasRoom)
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (existing !== undefined) {
    store.addThread(existing.id, input.threadId);
    return existing.id;
  }

  const gridId = store.createGrid({
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceKey,
  });
  store.addThread(gridId, input.threadId);
  return gridId;
}

/** Puts the parent in the cell a hidden child of it holds, and returns that cell's grid. */
function reclaimCellFromChild(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}): string | null {
  const store = useGridStore.getState();
  for (const grid of store.grids) {
    if (grid.tree === null) continue;
    for (const leaf of preorderThreads(grid.tree)) {
      const child = readThreadShell(scopeThreadRef(input.environmentId, leaf.threadId as ThreadId));
      if (child === null || child.lineage?.parentThreadId !== input.threadId) continue;
      if (!isSidebarHiddenThread(child)) continue;
      const moved = store.moveThreadToCell({
        threadId: input.threadId,
        targetGridId: grid.id,
        targetThreadId: leaf.threadId,
        side: "center",
        threadEnvironmentId: input.environmentId,
        threadProjectId: input.projectId,
      });
      if (moved) return grid.id;
    }
  }
  return null;
}
