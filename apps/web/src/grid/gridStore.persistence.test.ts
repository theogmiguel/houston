import { describe, expect, it, vi } from "vite-plus/test";

const data = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => void data.set(key, value),
  removeItem: (key: string) => void data.delete(key),
  clear: () => data.clear(),
  key: (index: number) => [...data.keys()][index] ?? null,
  get length() {
    return data.size;
  },
};

vi.stubGlobal("window", { localStorage: localStorageStub });

const created = [
  {
    id: "g-1",
    name: "Review",
    environmentId: "env-1",
    projectId: "project-1",
    workspaceKey: "env-1:project-1",
    tree: { kind: "thread", threadId: "thread-a", id: "p1" },
    focusedThreadId: "thread-a",
    pinnedAt: null,
    hidden: false,
    createdAt: "2026-01-01T00:00:00Z",
  },
];
data.set("houston:grids:v1", JSON.stringify({ state: { grids: created }, version: 1 }));

const { GRID_STORAGE_KEY, parseGrids, useGridStore } = await import("./gridStore");

describe("grid persistence", () => {
  it("rehydrates grids from the grid document", () => {
    expect(GRID_STORAGE_KEY).toBe("houston:grids:v1");
    expect(parseGrids(useGridStore.getState().grids)).toEqual(created);
  });

  it("persists later grid edits", () => {
    useGridStore.getState().addThread("g-1", "thread-b");
    const stored = JSON.parse(data.get(GRID_STORAGE_KEY) ?? "null") as {
      state: { grids: unknown };
    };
    expect(parseGrids(stored.state.grids)[0]!.tree).toMatchObject({
      kind: "split",
      children: [
        { kind: "thread", threadId: "thread-a" },
        { kind: "thread", threadId: "thread-b" },
      ],
    });
  });

  it("keeps the grid's details flag through a reload", () => {
    const readFlag = () =>
      parseGrids(
        (
          JSON.parse(data.get(GRID_STORAGE_KEY) ?? "null") as {
            state: { grids: unknown };
          }
        ).state.grids,
      )[0]!.detailsOpen;

    useGridStore.getState().setGridDetailsOpen("g-1", true);
    expect(readFlag()).toBe(true);

    useGridStore.getState().setGridDetailsOpen("g-1", false);
    expect(readFlag()).toBeUndefined();
  });

  it("keeps a pinned right panel through a reload and drops it with its thread", () => {
    const readPin = () =>
      parseGrids(
        (
          JSON.parse(data.get(GRID_STORAGE_KEY) ?? "null") as {
            state: { grids: unknown };
          }
        ).state.grids,
      )[0]!.panelPinnedThreadId;

    useGridStore.getState().setPanelPinnedThread("g-1", "thread-b");
    expect(readPin()).toBe("thread-b");

    useGridStore.getState().setPanelPinnedThread("g-1", "thread-missing");
    expect(readPin()).toBe("thread-b");

    useGridStore.getState().removeThreadFromGrid("g-1", "thread-b");
    expect(readPin()).toBeUndefined();
  });

  it("parses a stored pin only when its thread is in the tree", () => {
    const stored = { ...created[0]!, panelPinnedThreadId: "thread-a" };
    expect(parseGrids([stored])[0]!.panelPinnedThreadId).toBe("thread-a");
    expect(parseGrids([{ ...stored, panelPinnedThreadId: "thread-gone" }])[0]).not.toHaveProperty(
      "panelPinnedThreadId",
    );
    expect(parseGrids([{ ...stored, panelPinnedThreadId: 7 }])[0]).not.toHaveProperty(
      "panelPinnedThreadId",
    );
  });
});
