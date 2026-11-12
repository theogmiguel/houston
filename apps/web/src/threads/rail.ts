import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";

import { isSidebarHiddenThread } from "../components/Sidebar.logic";
import { gridContainingThread, type GridRecord } from "../grid/gridStore";

export interface RailWorkspace {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
}

/**
 * Live threads a workspace has but no grid shows. They keep running when a grid
 * is deleted, a cell is closed, the CLI starts them or a shelf reopen finds no
 * origin, so the rail lists them under the workspace instead of hiding them.
 */
export function ungroupedWorkspaceThreads(input: {
  readonly project: RailWorkspace;
  readonly grids: ReadonlyArray<GridRecord>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
}): EnvironmentThreadShell[] {
  const { project, grids, threads, now } = input;
  return threads.filter(
    (thread) =>
      thread.environmentId === project.environmentId &&
      thread.projectId === project.id &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.settledOverride !== "settled" &&
      !effectiveSnoozed(thread, { now }) &&
      !isSidebarHiddenThread(thread) &&
      gridContainingThread(grids, thread.environmentId, thread.id) === null,
  );
}

/** Workspaces the rail lists, with archived projects removed from its pickers. */
export function railWorkspaces<
  TProject extends RailWorkspace & { readonly archivedAt?: string | null | undefined },
>(projects: ReadonlyArray<TProject>): TProject[] {
  return projects.filter((project) => project.archivedAt === null);
}

export interface RailTarget {
  readonly threadId: string;
}

/**
 * The rail row `thread.previous` / `thread.next` moves to. The walk starts at
 * the focused row and stops at the ends; with no focused row it starts at the
 * matching end of the rail.
 */
export function nextRailTargetIndex(
  targets: ReadonlyArray<RailTarget>,
  current: RailTarget | null,
  direction: "previous" | "next",
): number | null {
  if (targets.length === 0) return null;
  const currentIndex =
    current === null ? -1 : targets.findIndex((target) => target.threadId === current.threadId);
  if (currentIndex === -1) return direction === "previous" ? targets.length - 1 : 0;
  const nextIndex = currentIndex + (direction === "previous" ? -1 : 1);
  return nextIndex < 0 || nextIndex >= targets.length ? null : nextIndex;
}

/** Pinned threads lead their grid's rows; the rest keep their configured order. */
export function pinnedThreadsFirst<T extends { readonly pinnedAt: string | null }>(
  threads: ReadonlyArray<T>,
): T[] {
  return threads.toSorted(
    (left, right) => Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null),
  );
}
