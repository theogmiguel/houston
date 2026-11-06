import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

type FilterableGroup = Pick<SidebarProjectSnapshot, "projectKey">;

/**
 * The groups the filter keeps. A stored key whose project is gone matches
 * nothing, and a filter that matches nothing means all projects, so the filter
 * returns with its project instead of emptying the rail.
 */
export function applyProjectFilter<T extends FilterableGroup>(
  groups: ReadonlyArray<T>,
  keys: ReadonlyArray<string>,
): T[] {
  if (keys.length === 0) return [...groups];
  const kept = groups.filter((group) => keys.includes(group.projectKey));
  return kept.length === 0 ? [...groups] : kept;
}

/** The stored keys that still name a project, in the order the rail lists them. */
export function activeProjectFilterKeys(
  groups: ReadonlyArray<FilterableGroup>,
  keys: ReadonlyArray<string>,
): string[] {
  if (keys.length === 0) return [];
  return groups.filter((group) => keys.includes(group.projectKey)).map((group) => group.projectKey);
}

/** Shift-click adds or removes one project; a plain click chooses only that project, or clears it when it was the only one. */
export function nextProjectFilterKeys(
  active: ReadonlyArray<string>,
  clickedKey: string | null,
  additive: boolean,
): string[] {
  if (clickedKey === null) return [];
  if (additive) {
    return active.includes(clickedKey)
      ? active.filter((key) => key !== clickedKey)
      : [...active, clickedKey];
  }
  return active.length === 1 && active[0] === clickedKey ? [] : [clickedKey];
}

/** Whether a thread's workspace is one of the groups the filter keeps. */
export function groupContainsWorkspace(
  group: Pick<SidebarProjectSnapshot, "memberProjectRefs">,
  workspace: { readonly environmentId: string; readonly projectId: string },
): boolean {
  return group.memberProjectRefs.some(
    (ref) => ref.environmentId === workspace.environmentId && ref.projectId === workspace.projectId,
  );
}
