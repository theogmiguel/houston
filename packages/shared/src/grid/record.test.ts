import { describe, expect, it } from "vite-plus/test";

import {
  type GridRecord,
  MAX_GRID_THREADS,
  addThreadToGrid,
  createGridRecord,
  moveThreadToGridRecords,
  parseGrids,
  pinGridRecord,
  placeThread,
  removeThreadFromGridRecord,
  renameGridRecord,
  setGridHiddenRecord,
  unpinGridRecord,
  workspaceKeyOf,
} from "./record.ts";
import { preorderThreads } from "./tree.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function grid(id: string, overrides: Partial<GridRecord> = {}, projectId = "p1"): GridRecord {
  return createGridRecord([], {
    id,
    now: NOW,
    environmentId: "env",
    projectId,
    workspaceKey: workspaceKeyOf("env", projectId),
    ...overrides,
  });
}

const ids = (record: GridRecord | undefined) =>
  record === undefined ? [] : preorderThreads(record.tree).map((leaf) => leaf.threadId);

describe("createGridRecord", () => {
  it("names a blank grid after the workspace's next free number", () => {
    const first = grid("g1");
    const second = createGridRecord([first], {
      id: "g2",
      now: NOW,
      environmentId: "env",
      projectId: "p1",
      workspaceKey: first.workspaceKey,
      name: "   ",
    });
    expect([first.name, second.name]).toEqual(["Grid 1", "Grid 2"]);
  });

  it("starts empty, unpinned and visible with the given id and time", () => {
    expect(grid("g1", { name: " Docs " })).toMatchObject({
      id: "g1",
      name: "Docs",
      tree: null,
      pinnedAt: null,
      hidden: false,
      createdAt: NOW,
    });
  });
});

describe("rename, hide and pin", () => {
  it("keeps the old name for a blank rename", () => {
    expect(renameGridRecord(grid("g1", { name: "A" }), "  ").name).toBe("A");
    expect(renameGridRecord(grid("g1", { name: "A" }), " B ").name).toBe("B");
  });

  it("hides and shows", () => {
    const hidden = setGridHiddenRecord(grid("g1"), true);
    expect(hidden.hidden).toBe(true);
    expect(setGridHiddenRecord(hidden, false).hidden).toBe(false);
  });

  it("pins once and unpins", () => {
    const pinned = pinGridRecord(grid("g1"), NOW);
    expect(pinGridRecord(pinned, "2027-01-01T00:00:00.000Z").pinnedAt).toBe(NOW);
    expect(unpinGridRecord(pinned).pinnedAt).toBeNull();
  });
});

describe("placeThread", () => {
  it("appends and takes the thread out of its previous grid", () => {
    const a = addThreadToGrid(grid("a"), "t1");
    const placed = placeThread([a, grid("b")], { gridId: "b", threadId: "t1" });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(ids(placed.grids.find((g) => g.id === "a"))).toEqual([]);
    expect(ids(placed.grids.find((g) => g.id === "b"))).toEqual(["t1"]);
  });

  it("refuses a full grid with the count and the limit", () => {
    let full = grid("a");
    for (let n = 0; n < MAX_GRID_THREADS; n += 1) full = addThreadToGrid(full, `t${n}`);
    expect(placeThread([full], { gridId: "a", threadId: "extra" })).toEqual({
      ok: false,
      reason: "grid_full",
      gridId: "a",
      threadCount: MAX_GRID_THREADS,
      limit: MAX_GRID_THREADS,
    });
    expect(placeThread([full], { gridId: "a", threadId: "t0" }).ok).toBe(true);
  });

  it("refuses an unknown grid by id", () => {
    expect(placeThread([], { gridId: "nope", threadId: "t" })).toEqual({
      ok: false,
      reason: "grid_not_found",
      gridId: "nope",
    });
  });
});

describe("moveThreadToGridRecords", () => {
  it("refuses a thread from another project and names both projects", () => {
    const target = grid("a");
    expect(
      moveThreadToGridRecords([target], {
        threadId: "t",
        threadEnvironmentId: "env",
        threadProjectId: "p2",
        targetGridId: "a",
      }),
    ).toMatchObject({
      ok: false,
      reason: "cross_project",
      threadProject: { environmentId: "env", projectId: "p2" },
      gridProject: { environmentId: "env", projectId: "p1" },
    });
  });

  it("moves a thread between two grids of one project", () => {
    const placed = moveThreadToGridRecords([addThreadToGrid(grid("a"), "t"), grid("b")], {
      threadId: "t",
      threadEnvironmentId: "env",
      threadProjectId: "p1",
      targetGridId: "b",
    });
    expect(placed.ok && ids(placed.grids.find((g) => g.id === "b"))).toEqual(["t"]);
  });
});

describe("removeThreadFromGridRecord", () => {
  it("drops the leaf and moves focus to a remaining thread", () => {
    const two = addThreadToGrid(addThreadToGrid(grid("a"), "t1"), "t2");
    const left = removeThreadFromGridRecord(two, "t2");
    expect(ids(left)).toEqual(["t1"]);
    expect(left.focusedThreadId).toBe("t1");
  });

  it("empties the grid when its last thread leaves", () => {
    const only = addThreadToGrid(grid("a"), "t1");
    expect(removeThreadFromGridRecord(only, "t1").tree).toBeNull();
  });
});

describe("parseGrids", () => {
  it("drops malformed entries and duplicate ids", () => {
    const good = grid("a");
    expect(parseGrids([good, { id: 1 }, good, null]).map((g) => g.id)).toEqual(["a"]);
    expect(parseGrids("nope")).toEqual([]);
  });
});
