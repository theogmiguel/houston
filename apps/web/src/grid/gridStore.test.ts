import { describe, expect, it } from "vite-plus/test";

import {
  addThreadToGrid,
  createGridRecord,
  gridById,
  gridsForWorkspace,
  orderedGridsForWorkspace,
  parseGrids,
  type GridRecord,
  useGridStore,
} from "./gridStore";
import { preorderLeaves } from "./tree";

const workspaceKey = "env-1:project-1";

function freshStore(): void {
  useGridStore.setState({ grids: [] });
}

function createdGrid(): GridRecord {
  const id = useGridStore.getState().createGrid({
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey,
    id: "g-1",
    now: "2026-01-01T00:00:00Z",
  });
  return gridById(useGridStore.getState().grids, id)!;
}

describe("grid records", () => {
  it("creates a grid scoped to one workspace with a stable default name", () => {
    freshStore();
    const first = createdGrid();
    const secondId = useGridStore.getState().createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey,
      id: "g-2",
      now: "2026-01-01T00:00:00Z",
    });
    const second = gridById(useGridStore.getState().grids, secondId)!;
    expect(first.name).toBe("Grid 1");
    expect(second.name).toBe("Grid 2");
    expect(gridsForWorkspace(useGridStore.getState().grids, workspaceKey)).toHaveLength(2);
    expect(gridsForWorkspace(useGridStore.getState().grids, "env-1:other")).toHaveLength(0);
  });

  it("renames, deletes and keeps names unique per workspace", () => {
    freshStore();
    createdGrid();
    useGridStore.getState().renameGrid("g-1", "Review");
    expect(gridById(useGridStore.getState().grids, "g-1")?.name).toBe("Review");
    useGridStore.getState().createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey,
      id: "g-2",
      now: "2026-01-01T00:00:00Z",
    });
    expect(gridById(useGridStore.getState().grids, "g-2")?.name).toBe("Grid 1");
    useGridStore.getState().deleteGrid("g-1");
    expect(gridById(useGridStore.getState().grids, "g-1")).toBeNull();
  });

  it("adds and removes a thread without touching the grid tree for a duplicate add", () => {
    freshStore();
    createdGrid();
    useGridStore.getState().addThread("g-1", "thread-a");
    useGridStore.getState().addThread("g-1", "thread-b");
    useGridStore.getState().addThread("g-1", "thread-a");
    const grid = gridById(useGridStore.getState().grids, "g-1")!;
    expect(preorderLeaves(grid.tree)).toEqual(["thread-a", "thread-b"]);
    expect(grid.focusedThreadId).toBe("thread-a");

    useGridStore.getState().removeThreadFromGrid("g-1", "thread-a");
    const after = gridById(useGridStore.getState().grids, "g-1")!;
    expect(preorderLeaves(after.tree)).toEqual(["thread-b"]);
    expect(after.focusedThreadId).toBe("thread-b");
  });

  it("accepts a draft cell and clears it when the draft is promoted", () => {
    freshStore();
    createdGrid();
    useGridStore.getState().addThread("g-1", "thread-a", "draft-a");
    const grid = gridById(useGridStore.getState().grids, "g-1")!;
    expect(grid.tree).toMatchObject({ kind: "thread", threadId: "thread-a", draftId: "draft-a" });

    useGridStore.getState().setDraftId("g-1", "thread-a", null);
    expect(
      (gridById(useGridStore.getState().grids, "g-1")!.tree as { draftId?: string }).draftId,
    ).toBeUndefined();
  });

  it("pins a grid above its workspace and hides it without touching its threads", () => {
    freshStore();
    createdGrid();
    useGridStore.getState().createGrid({
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey,
      id: "g-2",
      now: "2026-01-02T00:00:00Z",
    });
    useGridStore.getState().pinGrid("g-2", "2026-01-03T00:00:00Z");
    expect(
      orderedGridsForWorkspace(useGridStore.getState().grids, workspaceKey).map((grid) => grid.id),
    ).toEqual(["g-2", "g-1"]);
    useGridStore.getState().unpinGrid("g-2");
    expect(
      orderedGridsForWorkspace(useGridStore.getState().grids, workspaceKey).map((grid) => grid.id),
    ).toEqual(["g-1", "g-2"]);

    useGridStore.getState().addThread("g-1", "thread-a");
    useGridStore.getState().setGridHidden("g-1", true);
    const hidden = gridById(useGridStore.getState().grids, "g-1")!;
    expect(hidden.hidden).toBe(true);
    expect(preorderLeaves(hidden.tree)).toEqual(["thread-a"]);
  });

  it("reorders threads by swapping their panes", () => {
    freshStore();
    createdGrid();
    useGridStore.getState().addThread("g-1", "thread-a");
    useGridStore.getState().addThread("g-1", "thread-b");
    useGridStore.getState().reorderGridThreads("g-1", "thread-b", "thread-a");
    expect(preorderLeaves(gridById(useGridStore.getState().grids, "g-1")!.tree)).toEqual([
      "thread-b",
      "thread-a",
    ]);
  });

  it("follows the presets as an untouched grid fills instead of narrow columns", () => {
    freshStore();
    createdGrid();
    for (const threadId of ["thread-a", "thread-b", "thread-c", "thread-d", "thread-e"]) {
      useGridStore.getState().addThread("g-1", threadId);
    }
    const tree = gridById(useGridStore.getState().grids, "g-1")!.tree!;
    expect(preorderLeaves(tree)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
      "thread-d",
      "thread-e",
    ]);
    expect(tree.kind).toBe("split");
    if (tree.kind !== "split") return;
    expect(tree.dir).toBe("row");
    expect(tree.children).toHaveLength(2);
    expect(tree.weights[0]).toBeCloseTo(37.5);
  });

  it("keeps a manual split and can return it to the automatic arrangement", () => {
    freshStore();
    createdGrid();
    for (const threadId of ["thread-a", "thread-b", "thread-c"]) {
      useGridStore.getState().addThread("g-1", threadId);
    }
    const manual: GridRecord["tree"] = {
      kind: "split",
      dir: "col",
      children: [
        gridById(useGridStore.getState().grids, "g-1")!.tree!,
        { kind: "thread", threadId: "thread-d", id: "p4" },
      ],
      weights: [60, 40],
    };
    useGridStore.getState().setTree("g-1", manual);
    useGridStore.getState().addThread("g-1", "thread-e");
    const kept = gridById(useGridStore.getState().grids, "g-1")!.tree!;
    expect(kept.kind === "split" && kept.children).toHaveLength(3);
    expect(preorderLeaves(kept)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
      "thread-d",
      "thread-e",
    ]);

    useGridStore.getState().autoArrangeGrid("g-1");
    const auto = gridById(useGridStore.getState().grids, "g-1")!.tree!;
    expect(auto.kind === "split" && auto.children).toHaveLength(2);
    expect(preorderLeaves(auto)).toEqual([
      "thread-a",
      "thread-b",
      "thread-c",
      "thread-d",
      "thread-e",
    ]);
  });

  it("addThreadToGrid does not duplicate an existing thread", () => {
    const base = createGridRecord([], {
      environmentId: "env-1",
      projectId: "project-1",
      workspaceKey,
      id: "g-1",
      now: "2026-01-01T00:00:00Z",
    });
    const withThread = addThreadToGrid(base, "thread-a");
    const again = addThreadToGrid(withThread, "thread-a");
    expect(preorderLeaves(again.tree)).toEqual(["thread-a"]);
  });
});

describe("grid parsing", () => {
  const valid = {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey,
    tree: { kind: "thread", threadId: "thread-a", id: "p1" },
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("drops malformed records and repairs a stale focus", () => {
    expect(
      parseGrids([
        valid,
        { ...valid, id: "g-2", focusedThreadId: "gone" },
        { ...valid, id: "g-3", tree: { kind: "thread", threadId: "" } },
        { ...valid, id: "g-1" },
        null,
        "nope",
      ]),
    ).toEqual([valid, { ...valid, id: "g-2", focusedThreadId: "thread-a" }]);
  });

  it("returns an empty list for a corrupt document", () => {
    expect(parseGrids({ grids: [] })).toEqual([]);
    expect(parseGrids(undefined)).toEqual([]);
  });
});
