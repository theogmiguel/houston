import type { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";

import { gridContainingThread, MAX_GRID_THREADS, useGridStore, workspaceKeyOf } from "./gridStore";
import { preorderThreads } from "./tree";

/**
 * A thread a client started outside a grid (the root composer, a background send, a deep
 * link or the CLI) has no pane to show it in. Place it in its workspace's grid, creating one
 * when the workspace has none, so the sidebar's Grids section lists every running thread.
 */
export function ensureThreadInGrid(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly draftId?: string;
}): string | null {
  const store = useGridStore.getState();
  if (gridContainingThread(store.grids, input.environmentId, input.threadId) !== null) return null;
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
