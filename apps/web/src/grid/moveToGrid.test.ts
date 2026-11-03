import { describe, expect, it } from "vite-plus/test";

import { gridById, MAX_GRID_THREADS, useGridStore } from "./gridStore";
import { moveThreadToGridOrExplain } from "./moveToGrid";
import { preorderLeaves } from "./tree";

const workspaceKey = "env-1:project-1";

function gridWith(id: string, threadIds: readonly string[]): void {
  useGridStore.getState().createGrid({
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey,
    id,
    now: "2026-01-01T00:00:00Z",
  });
  for (const threadId of threadIds) useGridStore.getState().addThread(id, threadId);
}

describe("moveThreadToGridOrExplain", () => {
  it("moves the thread and returns no toast", () => {
    useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
    gridWith("g-1", ["thread-a"]);
    gridWith("g-2", []);
    expect(
      moveThreadToGridOrExplain({
        threadId: "thread-a",
        threadEnvironmentId: "env-1",
        threadProjectId: "project-1",
        targetGridId: "g-2",
      }),
    ).toBeNull();
    expect(preorderLeaves(gridById(useGridStore.getState().grids, "g-2")!.tree)).toEqual([
      "thread-a",
    ]);
  });

  it("explains a move into a full grid with the cap and the grid's count", () => {
    useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
    gridWith("g-1", ["thread-a"]);
    const full = Array.from({ length: MAX_GRID_THREADS }, (_, index) => `thread-${index}`);
    gridWith("g-2", full);
    const toast = moveThreadToGridOrExplain({
      threadId: "thread-a",
      threadEnvironmentId: "env-1",
      threadProjectId: "project-1",
      targetGridId: "g-2",
    });
    expect(toast).toEqual({
      title: "“Grid 2” is full",
      description: `A grid holds at most ${MAX_GRID_THREADS} threads and it already shows ${MAX_GRID_THREADS}. Move the thread to a new grid instead.`,
    });
    expect(preorderLeaves(gridById(useGridStore.getState().grids, "g-1")!.tree)).toEqual([
      "thread-a",
    ]);
  });
});
