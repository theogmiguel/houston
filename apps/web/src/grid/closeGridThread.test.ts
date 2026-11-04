import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { closeGridThread } from "./closeGridThread";
import { gridById, useGridStore } from "./gridStore";
import { preorderLeaves } from "./tree";

function seed(): void {
  useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
  useGridStore.getState().createGrid({
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    id: "g-1",
    now: "2026-01-01T00:00:00Z",
  });
  useGridStore.getState().addThread("g-1", "thread-a");
  useGridStore.getState().addThread("g-1", "thread-b");
}

describe("closeGridThread", () => {
  it("closes the thread and keeps its slot so reopening returns it to the grid", async () => {
    seed();
    const settle = vi.fn(async () => AsyncResult.success(undefined));
    await closeGridThread({ gridId: "g-1", threadId: "thread-a", settle });
    expect(settle).toHaveBeenCalledWith("thread-a");
    expect(preorderLeaves(gridById(useGridStore.getState().grids, "g-1")!.tree)).toEqual([
      "thread-b",
    ]);
    expect(useGridStore.getState().threadOrigins["thread-a"]).toEqual({ gridId: "g-1", slot: 0 });
  });

  it("leaves the grid untouched when closing fails", async () => {
    seed();
    const settle = vi.fn(async () => AsyncResult.failure(Cause.fail(new Error("offline"))));
    await closeGridThread({ gridId: "g-1", threadId: "thread-a", settle });
    expect(preorderLeaves(gridById(useGridStore.getState().grids, "g-1")!.tree)).toEqual([
      "thread-a",
      "thread-b",
    ]);
  });
});
