import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import type { GridRecord } from "./gridStore";

export interface RevealedThread {
  readonly grid: GridRecord;
  readonly thread: EnvironmentThreadShell;
}

/**
 * The open grid's focused thread when it is one of `grids`' visible threads.
 * A collapsed project or grid keeps this row on screen so the user never loses
 * the thread they are looking at.
 */
export function revealedOpenThread(
  grids: ReadonlyArray<{
    readonly grid: GridRecord;
    readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  }>,
  openGridId: string | null,
): RevealedThread | null {
  if (openGridId === null) return null;
  const entry = grids.find((candidate) => candidate.grid.id === openGridId);
  if (entry === undefined || entry.grid.focusedThreadId === null) return null;
  const thread = entry.threads.find((candidate) => candidate.id === entry.grid.focusedThreadId);
  return thread === undefined ? null : { grid: entry.grid, thread };
}
