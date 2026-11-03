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
