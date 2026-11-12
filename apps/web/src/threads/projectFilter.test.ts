import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  activeProjectFilterKeys,
  applyProjectFilter,
  groupContainsWorkspace,
  nextProjectFilterKeys,
  orderSidebarProjectGroups,
} from "./projectFilter";

const groups = [{ projectKey: "a" }, { projectKey: "b" }, { projectKey: "c" }];

describe("applyProjectFilter", () => {
  it("keeps every project when nothing is chosen", () => {
    expect(applyProjectFilter(groups, [])).toEqual(groups);
  });

  it("keeps the chosen projects in the rail's order", () => {
    expect(applyProjectFilter(groups, ["c", "a"]).map((group) => group.projectKey)).toEqual([
      "a",
      "c",
    ]);
  });

  it("shows every project when the chosen ones no longer exist", () => {
    expect(applyProjectFilter(groups, ["gone"])).toEqual(groups);
  });
});

describe("activeProjectFilterKeys", () => {
  it("drops stored keys with no project", () => {
    expect(activeProjectFilterKeys(groups, ["gone", "b"])).toEqual(["b"]);
    expect(activeProjectFilterKeys(groups, [])).toEqual([]);
  });
});

describe("nextProjectFilterKeys", () => {
  it("chooses one project on a plain click", () => {
    expect(nextProjectFilterKeys(["a", "b"], "c", false)).toEqual(["c"]);
  });

  it("clears the filter when the only chosen project is clicked again", () => {
    expect(nextProjectFilterKeys(["a"], "a", false)).toEqual([]);
  });

  it("narrows a many-project choice to the clicked project", () => {
    expect(nextProjectFilterKeys(["a", "b"], "a", false)).toEqual(["a"]);
  });

  it("adds and removes projects on Shift-click", () => {
    expect(nextProjectFilterKeys(["a"], "b", true)).toEqual(["a", "b"]);
    expect(nextProjectFilterKeys(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("clears the filter from All projects", () => {
    expect(nextProjectFilterKeys(["a", "b"], null, true)).toEqual([]);
  });
});

describe("groupContainsWorkspace", () => {
  it("matches on environment and project", () => {
    const group = { memberProjectRefs: [{ environmentId: "e1", projectId: "p1" }] } as never;
    expect(groupContainsWorkspace(group, { environmentId: "e1", projectId: "p1" })).toBe(true);
    expect(groupContainsWorkspace(group, { environmentId: "e2", projectId: "p1" })).toBe(false);
  });
});

function group(overrides: Record<string, unknown> = {}): SidebarProjectSnapshot {
  return {
    id: "project-1",
    environmentId: "env-1",
    title: "Houston",
    workspaceRoot: "/work/houston",
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    pinnedAt: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "env-1:/work/houston",
    displayName: "Houston",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: [
      {
        id: "project-1",
        environmentId: "env-1",
        title: "Houston",
        workspaceRoot: "/work/houston",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        projectKey: "env-1:/work/houston",
        displayName: "Houston",
        groupedProjectCount: 1,
        environmentPresence: "local-only",
        allRemoteMembersAreDesktopLocal: false,
        allRemoteMembersAreWsl: false,
        memberProjects: [],
        memberProjectRefs: [],
        remoteEnvironmentLabels: [],
        pinned: false,
        archived: false,
        physicalProjectKey: "env-1:/work/houston",
        environmentLabel: null,
      },
    ],
    memberProjectRefs: [{ environmentId: "env-1", projectId: "project-1" }],
    remoteEnvironmentLabels: [],
    pinned: overrides.pinnedAt != null,
    archived: overrides.archivedAt != null,
    ...overrides,
  } as unknown as SidebarProjectSnapshot;
}

function scratchGroup(): SidebarProjectSnapshot {
  const base = group();
  return group({
    id: "scratch",
    title: "Scratch",
    workspaceRoot: "/work/scratch",
    projectKey: "\0no-project",
    displayName: "No project",
    isScratch: true,
    memberProjects: [
      {
        ...base.memberProjects[0]!,
        id: "scratch",
        title: "Scratch",
        workspaceRoot: "/work/scratch",
        physicalProjectKey: "env-1:/work/scratch",
        isScratch: true,
      },
    ],
    memberProjectRefs: [{ environmentId: "env-1", projectId: "scratch" }],
  });
}

describe("orderSidebarProjectGroups", () => {
  it("puts pinned projects first, then the caller's order, with No project last", () => {
    const first = group({ projectKey: "first", displayName: "first" });
    const pinned = group({
      projectKey: "pinned",
      displayName: "pinned",
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
    const scratch = scratchGroup();

    expect(
      orderSidebarProjectGroups([first, pinned, scratch]).map((entry) => entry.projectKey),
    ).toEqual(["pinned", "first", "\0no-project"]);
  });

  it("drops archived groups", () => {
    const archived = group({ projectKey: "archived", archivedAt: "2026-01-02T00:00:00.000Z" });
    expect(orderSidebarProjectGroups([archived])).toEqual([]);
  });
});
