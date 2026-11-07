import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { GridRecord } from "../../grid/gridStore";
import { buildSidebarProjectSections, orderSidebarProjectGroups } from "./sidebarProjectSections";

function thread(id: string, projectId: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    id,
    environmentId: "env-1",
    projectId,
    title: id,
    branch: null,
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

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

function grid(overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "grid-a",
    name: "Grid 1",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: null,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const now = "2026-01-04T00:00:00.000Z";

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

describe("buildSidebarProjectSections", () => {
  it("keeps a project with no grids and puts scratch threads under No project", () => {
    const withGrid = group({ projectKey: "env-1:project-1", displayName: "Houston" });
    const empty = group({
      id: "project-2",
      title: "notes",
      projectKey: "env-1:project-2",
      displayName: "notes",
      memberProjects: [
        {
          ...group().memberProjects[0]!,
          id: "project-2",
          title: "notes",
          physicalProjectKey: "env-1:/work/notes",
        },
      ],
      memberProjectRefs: [{ environmentId: "env-1", projectId: "project-2" }],
    });
    const scratch = scratchGroup();

    const sections = buildSidebarProjectSections({
      groups: orderSidebarProjectGroups([withGrid, empty, scratch]),
      grids: [grid()],
      threads: [thread("loose", "project-1"), thread("scratch-thread", "scratch")],
      threadSort: "grid",
      gridSort: "created_at",
      nowIso: now,
      query: "",
      activityAt: () => 0,
    });

    expect(sections.map((section) => section.title)).toEqual(["Houston", "notes", "No project"]);
    expect(sections[0]?.grids.map((entry) => entry.grid.id)).toEqual(["grid-a"]);
    expect(sections[0]?.ungroupedThreads.map((entry) => entry.id)).toEqual(["loose"]);
    expect(sections[1]?.grids).toEqual([]);
    expect(sections[2]?.ungroupedThreads.map((entry) => entry.id)).toEqual(["scratch-thread"]);
  });

  it("orders a project's grids by pin, then the chosen sort", () => {
    const project = group();
    const older = grid({ id: "grid-old", name: "Older" });
    const pinned = grid({
      id: "grid-pinned",
      name: "Pinned",
      pinnedAt: "2026-01-02T00:00:00.000Z",
    });
    const newer = grid({
      id: "grid-new",
      name: "Newer",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const sections = buildSidebarProjectSections({
      groups: [project],
      grids: [newer, older, pinned],
      threads: [],
      threadSort: "grid",
      gridSort: "created_at",
      nowIso: now,
      query: "",
      activityAt: () => 0,
    });

    expect(sections[0]?.grids.map((entry) => entry.grid.id)).toEqual([
      "grid-pinned",
      "grid-old",
      "grid-new",
    ]);
  });

  it("keeps only what matches the search and still shows an empty matching project", () => {
    const withGrid = group();
    const empty = group({
      id: "project-2",
      title: "notes",
      projectKey: "env-1:project-2",
      displayName: "notes",
      memberProjects: [
        {
          ...group().memberProjects[0]!,
          id: "project-2",
          title: "notes",
          physicalProjectKey: "env-1:/work/notes",
        },
      ],
      memberProjectRefs: [{ environmentId: "env-1", projectId: "project-2" }],
    });

    const sections = buildSidebarProjectSections({
      groups: [withGrid, empty],
      grids: [grid({ name: "Review" })],
      threads: [thread("Loose", "project-1")],
      threadSort: "grid",
      gridSort: "created_at",
      nowIso: now,
      query: "notes",
      activityAt: () => 0,
    });

    expect(sections.map((section) => section.title)).toEqual(["notes"]);
    expect(sections[0]?.grids).toEqual([]);
    expect(sections[0]?.ungroupedThreads).toEqual([]);
  });

  it("lifts Needs you threads out of the project group and keeps them on the section", () => {
    const sections = buildSidebarProjectSections({
      groups: [group()],
      grids: [grid()],
      threads: [thread("needs", "project-1"), thread("other", "project-1")],
      threadSort: "grid",
      gridSort: "created_at",
      nowIso: now,
      query: "",
      activityAt: () => 0,
      excludedThreadIds: new Set(["needs"]),
    });

    expect(sections[0]?.ungroupedThreads.map((entry) => entry.id)).toEqual(["other"]);
    expect(sections[0]?.needsYouThreads?.map((entry) => entry.id)).toEqual(["needs"]);
  });

  it("keeps Needs you threads where they live while searching", () => {
    const sections = buildSidebarProjectSections({
      groups: [group()],
      grids: [grid()],
      threads: [thread("needs", "project-1")],
      threadSort: "grid",
      gridSort: "created_at",
      nowIso: now,
      query: "needs",
      activityAt: () => 0,
      excludedThreadIds: new Set(["needs"]),
    });

    expect(sections[0]?.ungroupedThreads.map((entry) => entry.id)).toEqual(["needs"]);
    expect(sections[0]?.needsYouThreads).toEqual([]);
  });
});
