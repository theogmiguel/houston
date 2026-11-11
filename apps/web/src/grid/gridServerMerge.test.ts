import type { HoustonGridRecord } from "@houston-app/contracts/houston/grids";
import { describe, expect, it } from "vite-plus/test";

import type { GridRecord } from "./gridStore";
import {
  mergeServerRecord,
  reconcileServerGrids,
  serverContentKey,
  toServerRecord,
} from "./gridServerMerge";

const leaf = (threadId: string) => ({ kind: "thread" as const, threadId, id: `p-${threadId}` });

const server = (overrides: Partial<HoustonGridRecord> = {}): HoustonGridRecord => ({
  id: "g-1",
  environmentId: "env-1",
  projectId: "project-1",
  workspaceKey: "env-1:project-1",
  name: "Review",
  tree: leaf("a"),
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 3,
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const local = (overrides: Partial<GridRecord> = {}): GridRecord => ({
  id: "g-1",
  name: "Old",
  environmentId: "env-1",
  projectId: "project-1",
  workspaceKey: "env-1:project-1",
  tree: leaf("a"),
  focusedThreadId: "a",
  pendingDraft: { draftId: "d-1", threadId: "t-9" },
  detailsOpen: true,
  panelPinnedThreadId: "a",
  pinnedAt: null,
  hidden: false,
  createdAt: "2025-12-31T00:00:00.000Z",
  ...overrides,
});

describe("mergeServerRecord", () => {
  it("takes the server's fields and keeps the renderer-only ones", () => {
    const merged = mergeServerRecord(
      local(),
      server({ name: "Renamed", pinnedAt: "2026-01-03T00:00:00.000Z", hidden: true }),
    );
    expect(merged).toMatchObject({
      name: "Renamed",
      pinnedAt: "2026-01-03T00:00:00.000Z",
      hidden: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      focusedThreadId: "a",
      pendingDraft: { draftId: "d-1", threadId: "t-9" },
      detailsOpen: true,
      panelPinnedThreadId: "a",
    });
  });

  it("moves focus and the pinned panel to a thread the server tree still has", () => {
    const merged = mergeServerRecord(local(), server({ tree: leaf("b") }));
    expect(merged.tree).toEqual(leaf("b"));
    expect(merged.focusedThreadId).toBe("b");
    expect(merged.panelPinnedThreadId).toBeUndefined();
  });

  it("builds a new grid from a record the cache has never seen", () => {
    const merged = mergeServerRecord(undefined, server({ tree: leaf("z") }));
    expect(merged).toEqual({
      id: "g-1",
      name: "Review",
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey: "env-1:project-1",
      tree: leaf("z"),
      focusedThreadId: "z",
      pinnedAt: null,
      hidden: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("serverContentKey", () => {
  it("ignores renderer-only fields, revision and timestamps", () => {
    const base = serverContentKey(local({ name: "Review" }));
    expect(
      serverContentKey(local({ name: "Review", focusedThreadId: null, detailsOpen: false })),
    ).toBe(base);
    expect(serverContentKey(server({ revision: 9, updatedAt: "2030-01-01T00:00:00.000Z" }))).toBe(
      serverContentKey(server()),
    );
    expect(serverContentKey(local({ name: "Review", createdAt: "1999-01-01T00:00:00.000Z" }))).toBe(
      base,
    );
  });

  it("changes with each server-owned field", () => {
    const base = serverContentKey(local());
    expect(serverContentKey(local({ name: "Other" }))).not.toBe(base);
    expect(serverContentKey(local({ hidden: true }))).not.toBe(base);
    expect(serverContentKey(local({ pinnedAt: "2026-01-01T00:00:00.000Z" }))).not.toBe(base);
    expect(serverContentKey(local({ tree: leaf("b") }))).not.toBe(base);
  });
});

describe("toServerRecord", () => {
  it("carries only server-owned fields", () => {
    expect(toServerRecord(local({ name: "Review" }), 3, "2026-01-02T00:00:00.000Z")).toEqual(
      server({ createdAt: "2025-12-31T00:00:00.000Z" }),
    );
  });
});

describe("reconcileServerGrids", () => {
  const input = (overrides: Partial<Parameters<typeof reconcileServerGrids>[0]> = {}) => ({
    grids: [] as GridRecord[],
    serverRevisions: {} as Record<string, number>,
    environmentId: "env-1",
    records: [] as HoustonGridRecord[],
    skip: new Set<string>(),
    ...overrides,
  });

  it("adds server grids and records their revisions", () => {
    const result = reconcileServerGrids(input({ records: [server({ revision: 4 })] }));
    expect(result.grids.map((grid) => grid.id)).toEqual(["g-1"]);
    expect(result.serverRevisions).toEqual({ "g-1": 4 });
  });

  it("replaces a grid only when the server revision is newer", () => {
    const grids = [local({ name: "Mine" })];
    const same = reconcileServerGrids(
      input({ grids, serverRevisions: { "g-1": 3 }, records: [server({ name: "Theirs" })] }),
    );
    expect(same.grids[0]!.name).toBe("Mine");
    const newer = reconcileServerGrids(
      input({
        grids,
        serverRevisions: { "g-1": 2 },
        records: [server({ name: "Theirs", revision: 3 })],
      }),
    );
    expect(newer.grids[0]!.name).toBe("Theirs");
    expect(newer.serverRevisions).toEqual({ "g-1": 3 });
  });

  it("leaves a grid with a push in flight alone", () => {
    const result = reconcileServerGrids(
      input({
        grids: [local({ name: "Mine" })],
        serverRevisions: { "g-1": 1 },
        records: [server({ name: "Theirs", revision: 5 })],
        skip: new Set(["g-1"]),
      }),
    );
    expect(result.grids[0]!.name).toBe("Mine");
    expect(result.serverRevisions).toEqual({ "g-1": 1 });
  });

  it("drops a grid the server deleted but keeps one it never saw", () => {
    const result = reconcileServerGrids(
      input({
        grids: [local({ id: "seen" }), local({ id: "never-sent" })],
        serverRevisions: { seen: 2 },
      }),
    );
    expect(result.grids.map((grid) => grid.id)).toEqual(["never-sent"]);
    expect(result.droppedIds).toEqual(["seen"]);
    expect(result.serverRevisions).toEqual({});
  });

  it("hands back the same arrays when the server told it nothing new", () => {
    const grids = [local({ id: "g-1" }), local({ id: "never-sent" })];
    const serverRevisions = { "g-1": 3 };
    const result = reconcileServerGrids(
      input({ grids, serverRevisions, records: [server({ revision: 3 })] }),
    );
    expect(result.grids).toBe(grids);
    expect(result.serverRevisions).toBe(serverRevisions);
    expect(result.droppedIds).toEqual([]);
  });

  it("never touches another environment's grids", () => {
    const other = local({ id: "other", environmentId: "env-2", workspaceKey: "env-2:p" });
    const result = reconcileServerGrids(
      input({ grids: [other], serverRevisions: { other: 1 }, records: [] }),
    );
    expect(result.grids).toEqual([other]);
    expect(result.serverRevisions).toEqual({ other: 1 });
  });
});
