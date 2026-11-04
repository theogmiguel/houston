import type { AtomCommandResult } from "@houston-app/client-runtime/state/runtime";

import { gridById, useGridStore } from "./gridStore";
import { preorderThreads } from "./tree";

/**
 * A cell's close button closes its thread: the thread goes to the Closed shelf
 * and keeps its slot, so reopening it from Closed puts it back here. A draft
 * cell has no thread to close and only leaves the grid.
 */
export async function closeGridThread(input: {
  readonly gridId: string;
  readonly threadId: string;
  readonly settle: (threadId: string) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<AtomCommandResult<unknown, unknown> | null> {
  const store = useGridStore.getState();
  const grid = gridById(store.grids, input.gridId);
  const leaf =
    grid?.tree == null
      ? undefined
      : preorderThreads(grid.tree).find((candidate) => candidate.threadId === input.threadId);
  if (leaf === undefined) return null;
  if (leaf.draftId !== undefined) {
    store.closeGridCell(input.gridId, input.threadId);
    return null;
  }
  const result = await input.settle(input.threadId);
  if (result._tag === "Success") useGridStore.getState().detachThreadForShelf(input.threadId);
  return result;
}
