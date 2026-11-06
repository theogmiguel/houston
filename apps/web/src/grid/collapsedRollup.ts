import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { resolveSidebarFolderDot } from "../components/Sidebar.logic";
import type { ThreadState } from "../components/ui/thread-state-glyph";
import type { GridRecord } from "./gridStore";

export interface CollapsedRollup {
  readonly count: number;
  readonly dot: { readonly state: ThreadState; readonly label: string } | null;
}

const ROLLUP_DOT = {
  attention: { state: "needs", label: "A hidden thread needs you" },
  failed: { state: "failed", label: "A hidden thread failed" },
  unread: { state: "ready", label: "A hidden thread finished" },
  working: { state: "running", label: "A hidden thread is running" },
} as const satisfies Record<string, { state: ThreadState; label: string }>;

/**
 * What a collapsed header says about the rows it hides: how many, and the
 * most urgent state among them (needs you, then failed, then finished and
 * unread, then running).
 */
export function collapsedRollup(hidden: ReadonlyArray<EnvironmentThreadShell>): CollapsedRollup {
  const dot = resolveSidebarFolderDot(hidden);
  return { count: hidden.length, dot: dot === null ? null : ROLLUP_DOT[dot] };
}

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
