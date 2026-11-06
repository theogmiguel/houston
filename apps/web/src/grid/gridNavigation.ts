import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import type { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";

import { readThreadShell } from "../state/entities";
import { gridContainingThread, useGridStore } from "./gridStore";
import { ensureThreadInGrid } from "./ensureThreadInGrid";

export interface GridThreadNavigationTarget {
  readonly gridId: string;
  readonly threadId: string;
}

/**
 * The grid a thread opens in. A thread already in a grid keeps its pane; one
 * that lives outside every grid is placed by the same rule the rest of the app
 * uses, so a notification or palette pick never strands it on a lone route.
 */
export function resolveGridThreadTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** A shelf's own wake or reopen returns the thread to its pane. */
  readonly fromShelf?: boolean;
}): GridThreadNavigationTarget | null {
  const store = useGridStore.getState();
  const containing = gridContainingThread(store.grids, input.environmentId, input.threadId);
  if (containing !== null) return { gridId: containing.id, threadId: input.threadId };

  const shell = readThreadShell(scopeThreadRef(input.environmentId, input.threadId));
  // A subagent has no rail row and never gets a cell of its own: it opens in its parent's cell,
  // or on its own page when no grid shows the parent.
  const parentThreadId = shell?.lineage?.parentThreadId ?? null;
  if (parentThreadId !== null) {
    const parentGrid = gridContainingThread(store.grids, input.environmentId, parentThreadId);
    if (parentGrid === null) return null;
    const moved = store.moveThreadToCell({
      threadId: input.threadId,
      targetGridId: parentGrid.id,
      targetThreadId: parentThreadId,
      side: "center",
      threadEnvironmentId: input.environmentId,
      threadProjectId: input.projectId,
    });
    return moved ? { gridId: parentGrid.id, threadId: input.threadId } : null;
  }
  const shelved =
    shell !== null &&
    (shell.settledOverride === "settled" ||
      effectiveSnoozed(shell, { now: new Date().toISOString() }));
  const origin = store.threadOrigins[input.threadId];
  // A shelf thread returns only through its own wake or reopen, not because a
  // palette pick or notification pulled it back onto the rail.
  if (origin !== undefined && (input.fromShelf === true || !shelved)) {
    const gridId = store.returnThreadToOrigin(input);
    return gridId === null ? null : { gridId, threadId: input.threadId };
  }

  const gridId = ensureThreadInGrid(input);
  return gridId === null ? null : { gridId, threadId: input.threadId };
}
