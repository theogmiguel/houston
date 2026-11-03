export interface ProjectOwner {
  readonly environmentId: string;
  readonly projectId: string;
}

/** A thread belongs to one project in one environment; a grid belongs to exactly one. */
export function sameProject(left: ProjectOwner, right: ProjectOwner): boolean {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

/** The toast for a refused cross-project move names both projects. */
export function crossProjectMoveToast(
  threadProjectTitle: string,
  gridProjectTitle: string,
): { title: string; description: string } {
  return {
    title: "Cannot move across projects",
    description: `This thread belongs to “${threadProjectTitle}”; the grid belongs to “${gridProjectTitle}”.`,
  };
}

/** The toast for a move refused by the grid cap names the cap, the grid's count and the way out. */
export function gridFullMoveToast(
  gridName: string,
  shownCount: number,
  maxThreads: number,
): { title: string; description: string } {
  return {
    title: `“${gridName}” is full`,
    description: `A grid holds at most ${maxThreads} threads and it already shows ${shownCount}. Move the thread to a new grid instead.`,
  };
}

/** The toast for a thread that belongs to no project: a grid only shows its own project. */
export function noProjectMoveToast(gridName: string): { title: string; description: string } {
  return {
    title: "Cannot move this thread",
    description: `This thread has no project, and “${gridName}” only shows threads from its own project.`,
  };
}

/** Why a dragged thread cannot land on a cell, or null when it can. */
export type ThreadDropRefusal = "different-project" | "grid-full";

/** The refusal zone's label; it names the reason the drop will not happen. */
export const THREAD_DROP_REFUSAL_LABEL: Readonly<Record<ThreadDropRefusal, string>> = {
  "different-project": "Different project",
  "grid-full": "Grid full",
};

/**
 * A drop is refused before it happens: across projects always, and at the cap
 * when the drop would add a cell. A centre drop replaces a cell, so it is the
 * way into a full grid.
 */
export function threadDropRefusal(input: {
  readonly threadProject: ProjectOwner;
  readonly grid: ProjectOwner;
  readonly side: "center" | "left" | "right" | "top" | "bottom";
  readonly sourceInTarget: boolean;
  readonly targetCount: number;
  readonly maxThreads: number;
}): ThreadDropRefusal | null {
  if (!sameProject(input.threadProject, input.grid)) return "different-project";
  if (input.side !== "center" && !input.sourceInTarget && input.targetCount >= input.maxThreads) {
    return "grid-full";
  }
  return null;
}
