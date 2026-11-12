import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  nextRailTargetIndex,
  pinnedThreadsFirst,
  railWorkspaces,
  ungroupedWorkspaceThreads,
} from "./rail";
import { useGridStore, workspaceKeyOf } from "../grid/gridStore";

const environmentId = "env-1";
const projectId = "project-1";
const workspaceKey = workspaceKeyOf(environmentId, projectId);

function thread(id: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    id,
    environmentId,
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

const project = { environmentId, id: projectId, title: "Houston" } as const;
const now = "2026-01-04T00:00:00.000Z";

afterEach(() => {
  useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
});

describe("ungroupedWorkspaceThreads", () => {
  it("lists the live threads no grid shows", () => {
    const gridId = useGridStore.getState().createGrid({
      environmentId,
      projectId,
      workspaceKey,
    });
    useGridStore.getState().addThread(gridId, "shown");
    const result = ungroupedWorkspaceThreads({
      project,
      grids: useGridStore.getState().grids,
      threads: [thread("shown"), thread("outside")],
      now,
    });
    expect(result.map((entry) => entry.id)).toEqual(["outside"]);
  });

  it("leaves out closed, held, archived and subagent threads", () => {
    const result = ungroupedWorkspaceThreads({
      project,
      grids: [],
      threads: [
        thread("live"),
        thread("closed", { settledOverride: "settled" }),
        thread("held", { snoozedUntil: "2026-12-01T00:00:00.000Z" }),
        thread("archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        thread("child", {
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: ThreadId.make("live"),
            rootThreadId: ThreadId.make("live"),
            sideChat: false,
          },
        }),
      ],
      now,
    });
    expect(result.map((entry) => entry.id)).toEqual(["live"]);
  });
});

describe("railWorkspaces", () => {
  it("drops archived projects from the rail", () => {
    expect(
      railWorkspaces([
        { ...project, archivedAt: null },
        { ...project, id: "project-2", archivedAt: "2026-01-01T00:00:00.000Z" },
      ]).map((entry) => entry.id),
    ).toEqual([projectId]);
  });
});

describe("nextRailTargetIndex", () => {
  const targets = [
    { gridId: "g-1", threadId: "a" },
    { gridId: "g-1", threadId: "b" },
    { gridId: null, threadId: "c" },
  ];

  it("walks the rail and stops at its ends", () => {
    expect(nextRailTargetIndex(targets, targets[0]!, "next")).toBe(1);
    expect(nextRailTargetIndex(targets, targets[2]!, "previous")).toBe(1);
    expect(nextRailTargetIndex(targets, targets[0]!, "previous")).toBeNull();
    expect(nextRailTargetIndex(targets, targets[2]!, "next")).toBeNull();
  });

  it("starts at the matching end when no row is focused", () => {
    expect(nextRailTargetIndex(targets, null, "next")).toBe(0);
    expect(nextRailTargetIndex(targets, null, "previous")).toBe(2);
  });
});

describe("pinnedThreadsFirst", () => {
  it("lifts pinned threads and keeps the rest in order", () => {
    expect(
      pinnedThreadsFirst([
        { id: "a", pinnedAt: null },
        { id: "b", pinnedAt: "2026-01-02T00:00:00.000Z" },
        { id: "c", pinnedAt: null },
      ]).map((thread) => thread.id),
    ).toEqual(["b", "a", "c"]);
  });
});
