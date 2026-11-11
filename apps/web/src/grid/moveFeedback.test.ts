import { describe, expect, it } from "vite-plus/test";

import { useGridStore } from "./gridStore";
import { undoThreadMove, type ThreadMoveFeedback } from "./moveFeedback";
import { preorderLeaves } from "@houston-app/shared/grid/tree";

function seed() {
  useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
  const store = useGridStore.getState();
  store.createGrid({
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    id: "g-source",
    now: "2026-01-01T00:00:00Z",
  });
  store.createGrid({
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    id: "g-target",
    now: "2026-01-02T00:00:00Z",
  });
  store.addThread("g-source", "thread-a");
  store.addThread("g-target", "thread-a");
}

function feedback(overrides: Partial<ThreadMoveFeedback> = {}): ThreadMoveFeedback {
  return {
    threadId: "thread-a",
    threadEnvironmentId: "env-1",
    threadProjectId: "project-1",
    threadTitle: "Thread A",
    sourceGridId: "g-source",
    targetGridId: "g-target",
    onOpenTarget: () => {},
    ...overrides,
  };
}

describe("undoThreadMove", () => {
  it("moves the thread back to the grid it came from", () => {
    seed();
    undoThreadMove(feedback());
    const grids = useGridStore.getState().grids;
    expect(preorderLeaves(grids.find((grid) => grid.id === "g-source")!.tree)).toEqual([
      "thread-a",
    ]);
    expect(grids.find((grid) => grid.id === "g-target")!.tree).toBeNull();
  });

  it("removes the thread from the grid when no grid showed it before", () => {
    seed();
    undoThreadMove(feedback({ sourceGridId: null }));
    expect(useGridStore.getState().grids.find((grid) => grid.id === "g-target")!.tree).toBeNull();
  });
});
