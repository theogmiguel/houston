import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { getProjectOrderKey } from "@houston-app/client-runtime/state/project-grouping";
import { sortThreads } from "@houston-app/client-runtime/state/thread-sort";
import type {
  SidebarGridSortOrder,
  SidebarGridThreadSortOrder,
} from "@houston-app/contracts/settings";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { sidebarOrderedGrids, workspaceKeyOf, type GridRecord } from "../../grid/gridStore";
import { pinnedThreadsFirst, ungroupedWorkspaceThreads } from "../../grid/rail";
import { threadMatchesGridSearch, visibleGridThreads } from "../../grid/sidebar";

export interface SidebarProjectSectionGrid {
  readonly grid: GridRecord;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export interface SidebarProjectSection {
  readonly projectKey: string;
  readonly title: string;
  readonly isScratch: boolean;
  readonly environmentId: string;
  readonly projectId: string;
  readonly grids: ReadonlyArray<SidebarProjectSectionGrid>;
  readonly hiddenGrids: ReadonlyArray<GridRecord>;
  readonly ungroupedThreads: ReadonlyArray<EnvironmentThreadShell>;
}

export interface SidebarProjectSectionsInput {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly grids: ReadonlyArray<GridRecord>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly threadSort: SidebarGridThreadSortOrder;
  readonly gridSort: SidebarGridSortOrder;
  readonly nowIso: string;
  readonly query: string;
  readonly activityAt: (grid: GridRecord) => number;
}

/**
 * Pinned projects lead, then the order the caller gives. Threads with no
 * project (the scratch group) always sit at the foot of the rail.
 */
export function orderSidebarProjectGroups(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): SidebarProjectSnapshot[] {
  const open = groups.filter((group) => !group.archived);
  const projects = open.filter((group) => !group.isScratch);
  const scratch = open.filter((group) => group.isScratch);
  return [
    ...projects.filter((group) => group.pinned),
    ...projects.filter((group) => !group.pinned),
    ...scratch,
  ];
}

/**
 * The stored project order after dragging one rail project next to another, or
 * null when the drop changes nothing. `groups` is the rail's displayed order.
 * The scratch group has no place in the order, and a project stays within its
 * pinned or unpinned run because pinned projects always lead the rail.
 */
export function moveProjectGroup(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly draggedKey: string;
  readonly targetKey: string;
  readonly side: "before" | "after";
}): string[] | null {
  const { groups, draggedKey, targetKey, side } = input;
  if (draggedKey === targetKey) return null;
  const dragged = groups.find((group) => group.projectKey === draggedKey);
  const target = groups.find((group) => group.projectKey === targetKey);
  if (dragged === undefined || target === undefined) return null;
  if (dragged.isScratch === true || target.isScratch === true) return null;
  if (dragged.pinned !== target.pinned) return null;

  const rest = groups.filter((group) => group.projectKey !== draggedKey);
  const targetIndex = rest.findIndex((group) => group.projectKey === targetKey);
  const next = [...rest];
  next.splice(side === "before" ? targetIndex : targetIndex + 1, 0, dragged);
  if (next.every((group, index) => group === groups[index])) return null;
  return next.flatMap((group) => group.memberProjects.map((member) => getProjectOrderKey(member)));
}

function sortSectionThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  order: SidebarGridThreadSortOrder,
): EnvironmentThreadShell[] {
  return pinnedThreadsFirst(order === "grid" ? threads : sortThreads(threads, order));
}

function normalizeQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * Turns the rail's project groups into sections: each project's grids with the
 * threads each grid shows, then the project's threads that no grid shows.
 */
export function buildSidebarProjectSections(
  input: SidebarProjectSectionsInput,
): SidebarProjectSection[] {
  const query = normalizeQuery(input.query);
  return input.groups.flatMap((group): SidebarProjectSection[] => {
    const members = group.memberProjects.filter((member) => member.archivedAt == null);
    if (members.length === 0) return [];
    const target =
      members.find(
        (member) => member.environmentId === group.environmentId && member.id === group.id,
      ) ?? members[0]!;
    const titleMatches = query.length > 0 && group.displayName.toLocaleLowerCase().includes(query);

    const orderedGrids = members
      .flatMap((member) =>
        sidebarOrderedGrids(
          input.grids,
          workspaceKeyOf(member.environmentId, member.id),
          input.gridSort,
          input.activityAt,
        ),
      )
      .toSorted((left, right) => Number(right.pinnedAt !== null) - Number(left.pinnedAt !== null));
    const hiddenGrids = orderedGrids.filter((grid) => grid.hidden);

    const grids = orderedGrids.flatMap((grid): SidebarProjectSectionGrid[] => {
      if (grid.hidden) return [];
      const gridMatches = query.length > 0 && grid.name.toLocaleLowerCase().includes(query);
      const gridThreads = sortSectionThreads(
        visibleGridThreads(grid, input.threads, input.nowIso),
        input.threadSort,
      );
      const threads =
        query.length === 0 || titleMatches || gridMatches
          ? gridThreads
          : gridThreads.filter((thread) =>
              threadMatchesGridSearch(
                {
                  title: thread.title,
                  branch: thread.branch,
                  pullRequests: thread.pullRequests,
                },
                query,
              ),
            );
      if (query.length > 0 && !titleMatches && !gridMatches && threads.length === 0) return [];
      return [{ grid, threads }];
    });

    const ungroupedThreads = sortSectionThreads(
      members.flatMap((member) =>
        ungroupedWorkspaceThreads({
          project: member,
          grids: input.grids,
          threads: input.threads,
          now: input.nowIso,
        }),
      ),
      input.threadSort,
    ).filter(
      (thread) =>
        query.length === 0 ||
        titleMatches ||
        threadMatchesGridSearch(
          { title: thread.title, branch: thread.branch, pullRequests: thread.pullRequests },
          query,
        ),
    );

    if (query.length > 0 && !titleMatches && grids.length === 0 && ungroupedThreads.length === 0) {
      return [];
    }
    if (
      group.isScratch &&
      query.length === 0 &&
      grids.length === 0 &&
      ungroupedThreads.length === 0
    ) {
      return [];
    }

    return [
      {
        projectKey: group.projectKey,
        title: group.displayName,
        isScratch: group.isScratch === true,
        environmentId: target.environmentId,
        projectId: target.id,
        grids,
        hiddenGrids,
        ungroupedThreads,
      },
    ];
  });
}
