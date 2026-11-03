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
