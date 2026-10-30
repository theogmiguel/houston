import { describe, expect, it } from "vite-plus/test";

import {
  MAX_GRID_THREADS,
  detachThreadForShelf,
  parseThreadOrigins,
  returnThreadToOrigin,
  type GridRecord,
  type ThreadOrigins,
} from "./gridStore";
import { preorderLeaves } from "./tree";

const workspaceKey = "env-1:project-1";
const now = "2026-10-29T12:00:00.000Z";

function grid(overrides: Partial<GridRecord> = {}): GridRecord {
  return {
    id: "g-1",
    name: "Grid 1",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey,
    tree: { kind: "thread", threadId: "thread-a", id: "p1" },
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function row(threadIds: string[]): GridRecord["tree"] {
  return {
    kind: "split",
    dir: "row",
    children: threadIds.map((threadId, index) => ({
      kind: "thread",
      threadId,
      id: `p${index}`,
    })),
    weights: threadIds.map(() => 100 / threadIds.length),
  };
}

function sixThreads(): GridRecord["tree"] {
  return row(["t1", "t2", "t3", "t4", "t5", "t6"]);
}

function origins(entry: ThreadOrigins[string]): ThreadOrigins {
  return { "thread-b": entry };
}

describe("return to origin", () => {
  it("remembers the pane a thread left", () => {
    const detached = detachThreadForShelf(
      [grid({ tree: row(["thread-a", "thread-b", "thread-c"]) })],
      {},
      "thread-b",
    );
    expect(detached.threadOrigins["thread-b"]).toEqual({ gridId: "g-1", slot: 1 });
    expect(preorderLeaves(detached.grids[0]!.tree)).toEqual(["thread-a", "thread-c"]);
  });

  it("returns a thread to its original grid and slot", () => {
    const returned = returnThreadToOrigin(
      [grid({ tree: row(["thread-a", "thread-c"]) })],
      origins({ gridId: "g-1", slot: 1 }),
      { threadId: "thread-b", environmentId: "env-1", projectId: "project-1", now },
    );
    expect(returned.gridId).toBe("g-1");
    expect(preorderLeaves(returned.grids[0]!.tree)).toEqual(["thread-a", "thread-b", "thread-c"]);
    expect(returned.threadOrigins).toEqual({});
  });

  it("creates a new grid when the origin grid is gone", () => {
    const returned = returnThreadToOrigin([], origins({ gridId: "g-gone", slot: 0 }), {
      threadId: "thread-b",
      environmentId: "env-1",
      projectId: "project-1",
      now,
    });
    expect(returned.gridId).not.toBeNull();
    expect(returned.gridId).not.toBe("g-gone");
    expect(returned.grids).toHaveLength(1);
    expect(returned.grids[0]!.workspaceKey).toBe(workspaceKey);
    expect(preorderLeaves(returned.grids[0]!.tree)).toEqual(["thread-b"]);
  });

  it("creates a new grid when the origin grid is hidden", () => {
    const returned = returnThreadToOrigin(
      [grid({ hidden: true })],
      origins({ gridId: "g-1", slot: 0 }),
      { threadId: "thread-b", environmentId: "env-1", projectId: "project-1", now },
    );
    expect(returned.gridId).not.toBe("g-1");
    expect(returned.grids[1]!.hidden).toBe(false);
  });

  it("creates a new grid when the origin grid already holds six threads", () => {
    const returned = returnThreadToOrigin(
      [grid({ tree: sixThreads() })],
      origins({ gridId: "g-1", slot: 2 }),
      { threadId: "thread-b", environmentId: "env-1", projectId: "project-1", now },
    );
    expect(preorderLeaves(returned.grids[0]!.tree)).toHaveLength(MAX_GRID_THREADS);
    expect(returned.gridId).not.toBe("g-1");
    expect(preorderLeaves(returned.grids[1]!.tree)).toEqual(["thread-b"]);
  });

  it("does not duplicate a thread that is already in a grid", () => {
    const returned = returnThreadToOrigin(
      [grid({ id: "g-2", tree: { kind: "thread", threadId: "thread-b", id: "p2" } })],
      origins({ gridId: "g-1", slot: 0 }),
      { threadId: "thread-b", environmentId: "env-1", projectId: "project-1", now },
    );
    expect(returned.gridId).toBe("g-2");
    expect(returned.grids).toHaveLength(1);
    expect(returned.threadOrigins).toEqual({});
  });

  it("drops an origin whose grid no longer keeps the thread", () => {
    const returned = returnThreadToOrigin([], origins({ gridId: "g-1", slot: 0 }), {
      threadId: "thread-b",
      environmentId: "env-1",
      projectId: "project-1",
      now,
    });
    expect(returned.threadOrigins).toEqual({});
  });
});

describe("thread origin parsing", () => {
  it("keeps only well-formed origins", () => {
    expect(
      parseThreadOrigins({
        "thread-a": { gridId: "g-1", slot: 2 },
        "thread-b": { gridId: "", slot: 0 },
        "thread-c": { gridId: "g-2", slot: -1 },
        "thread-d": { gridId: "g-3", slot: 1.8 },
        "thread-e": null,
      }),
    ).toEqual({
      "thread-a": { gridId: "g-1", slot: 2 },
      "thread-d": { gridId: "g-3", slot: 1 },
    });
  });
});
