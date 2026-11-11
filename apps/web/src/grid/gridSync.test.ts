import type {
  HoustonGridPutInput,
  HoustonGridPutResult,
  HoustonGridRecord,
} from "@houston-app/contracts/houston/grids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GRID_PUSH_DEBOUNCE_MS, startGridSync, type GridSyncDeps } from "./gridSync";
import { type GridRecord, useGridStore } from "./gridStore";

const leaf = (threadId: string) => ({ kind: "thread" as const, threadId, id: `p-${threadId}` });
const ENV = "env-1";

const record = (overrides: Partial<HoustonGridRecord> = {}): HoustonGridRecord => ({
  id: "g-1",
  environmentId: ENV,
  projectId: "project-1",
  workspaceKey: `${ENV}:project-1`,
  name: "Review",
  tree: leaf("a"),
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const localGrid = (overrides: Partial<GridRecord> = {}): GridRecord => ({
  id: "g-1",
  name: "Review",
  environmentId: ENV,
  projectId: "project-1",
  workspaceKey: `${ENV}:project-1`,
  tree: leaf("a"),
  focusedThreadId: "a",
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

interface Harness {
  readonly puts: Array<{ environmentId: string; input: HoustonGridPutInput }>;
  readonly deletes: Array<{ environmentId: string; gridId: string }>;
  readonly imported: Set<string>;
  readonly reports: string[];
  respondPut: (respond: (input: HoustonGridPutInput) => HoustonGridPutResult) => void;
  connect: (ids: string[]) => void;
  serverSnapshot: (environmentId: string, grids: HoustonGridRecord[]) => void;
  stop: () => void;
}

function start(): Harness {
  const puts: Harness["puts"] = [];
  const deletes: Harness["deletes"] = [];
  const imported = new Set<string>();
  const reports: string[] = [];
  let respond: (input: HoustonGridPutInput) => HoustonGridPutResult = (input) => ({
    status: "saved",
    grid: { ...input.grid, revision: input.expectedRevision + 1 },
  });
  let connectedListener: ((ids: ReadonlyArray<string>) => void) | null = null;
  const gridListeners = new Map<
    string,
    (snapshot: { grids: HoustonGridRecord[]; loaded: boolean }) => void
  >();
  const deps: GridSyncDeps = {
    store: useGridStore,
    watchConnectedEnvironments: (listener) => {
      connectedListener = listener;
      return () => {
        connectedListener = null;
      };
    },
    watchServerGrids: (environmentId, listener) => {
      gridListeners.set(environmentId, listener);
      return () => gridListeners.delete(environmentId);
    },
    put: async (environmentId, input) => {
      puts.push({ environmentId, input });
      return respond(input);
    },
    delete: async (environmentId, gridId) => {
      deletes.push({ environmentId, gridId });
      return { deleted: true };
    },
    importedEnvironments: {
      has: (id) => imported.has(id),
      add: (id) => void imported.add(id),
    },
    now: () => "2026-02-01T00:00:00.000Z",
    report: (message) => void reports.push(message),
  };
  const stop = startGridSync(deps);
  return {
    puts,
    deletes,
    imported,
    reports,
    respondPut: (next) => {
      respond = next;
    },
    connect: (ids) => connectedListener?.(ids),
    serverSnapshot: (environmentId, grids) =>
      gridListeners.get(environmentId)?.({ grids, loaded: true }),
    stop,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(GRID_PUSH_DEBOUNCE_MS + 1);
const grids = () => useGridStore.getState().grids;

beforeEach(() => {
  vi.useFakeTimers();
  useGridStore.setState({ grids: [], serverRevisions: {}, closedCells: {}, threadOrigins: {} });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("server to store", () => {
  it("shows a server snapshot and keeps this window's focus and panel flags", async () => {
    const sync = start();
    useGridStore.setState({
      grids: [localGrid({ name: "Old", detailsOpen: true, focusedThreadId: "a" })],
      serverRevisions: { "g-1": 1 },
    });
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record({ name: "New", revision: 2, tree: leaf("b") })]);
    expect(grids()[0]).toMatchObject({
      name: "New",
      detailsOpen: true,
      focusedThreadId: "b",
      tree: leaf("b"),
    });
    expect(useGridStore.getState().serverRevisions).toEqual({ "g-1": 2 });
    await settle();
    expect(sync.puts).toEqual([]);
    sync.stop();
  });

  it("does not send back a change that came from the server", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    sync.serverSnapshot(ENV, [record({ name: "By an agent", revision: 2 })]);
    await settle();
    expect(grids()[0]!.name).toBe("By an agent");
    expect(sync.puts).toEqual([]);
    expect(sync.deletes).toEqual([]);
    sync.stop();
  });

  it("drops a grid the server deleted without calling delete", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    sync.serverSnapshot(ENV, []);
    await settle();
    expect(grids()).toEqual([]);
    expect(sync.deletes).toEqual([]);
    sync.stop();
  });
});

describe("store to server", () => {
  it("sends a local change with the last known revision and records the saved one", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record({ revision: 4 })]);
    useGridStore.getState().renameGrid("g-1", "Renamed");
    await settle();
    expect(sync.puts).toHaveLength(1);
    expect(sync.puts[0]!.input.expectedRevision).toBe(4);
    expect(sync.puts[0]!.input.grid).toMatchObject({ id: "g-1", name: "Renamed" });
    expect(useGridStore.getState().serverRevisions["g-1"]).toBe(5);
    await settle();
    expect(sync.puts).toHaveLength(1);
    sync.stop();
  });

  it("sends one put for a burst of changes to the same grid", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    for (const name of ["a", "ab", "abc"]) {
      useGridStore.getState().renameGrid("g-1", name);
      await vi.advanceTimersByTimeAsync(GRID_PUSH_DEBOUNCE_MS - 50);
    }
    expect(sync.puts).toHaveLength(0);
    await settle();
    expect(sync.puts).toHaveLength(1);
    expect(sync.puts[0]!.input.grid.name).toBe("abc");
    sync.stop();
  });

  it("does not send a change to focus or the open panel", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [
      record({
        tree: { kind: "split", dir: "row", children: [leaf("a"), leaf("b")], weights: [1, 1] },
      }),
    ]);
    useGridStore.getState().focusThread("g-1", "b");
    useGridStore.getState().setGridDetailsOpen("g-1", true);
    await settle();
    expect(sync.puts).toEqual([]);
    sync.stop();
  });

  it("creates a new grid with expected revision 0", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, []);
    const id = useGridStore.getState().createGrid({
      environmentId: ENV,
      projectId: "project-1",
      workspaceKey: `${ENV}:project-1`,
      id: "g-new",
      now: "2026-01-05T00:00:00.000Z",
    });
    await settle();
    expect(sync.puts[0]!.input.expectedRevision).toBe(0);
    expect(sync.puts[0]!.input.grid.id).toBe(id);
    expect(useGridStore.getState().serverRevisions[id]).toBe(1);
    sync.stop();
  });

  it("deletes on the server when a synced grid is deleted locally", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    useGridStore.getState().deleteGrid("g-1");
    await settle();
    expect(sync.deletes).toEqual([{ environmentId: ENV, gridId: "g-1" }]);
    sync.stop();
  });

  it("sends nothing for a grid created and deleted before it was ever saved", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, []);
    useGridStore.getState().createGrid({
      environmentId: ENV,
      projectId: "project-1",
      workspaceKey: `${ENV}:project-1`,
      id: "g-brief",
    });
    useGridStore.getState().deleteGrid("g-brief");
    await settle();
    expect(sync.puts).toEqual([]);
    expect(sync.deletes).toEqual([]);
    sync.stop();
  });
});

describe("conflicts", () => {
  it("adopts the server's grid when a put conflicts", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    sync.respondPut(() => ({
      status: "conflict",
      current: record({ name: "Agent's name", revision: 7, tree: leaf("z") }),
    }));
    useGridStore.getState().renameGrid("g-1", "Mine");
    await settle();
    expect(grids()[0]).toMatchObject({
      name: "Agent's name",
      tree: leaf("z"),
      focusedThreadId: "z",
    });
    expect(useGridStore.getState().serverRevisions["g-1"]).toBe(7);
    await settle();
    expect(sync.puts).toHaveLength(1);
    sync.stop();
  });

  it("drops the grid when the conflict says the server deleted it", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    sync.respondPut(() => ({ status: "conflict", current: null }));
    useGridStore.getState().renameGrid("g-1", "Mine");
    await settle();
    expect(grids()).toEqual([]);
    await settle();
    expect(sync.deletes).toEqual([]);
    sync.stop();
  });

  it("reports a refused put and keeps the local grid", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record()]);
    sync.respondPut(() => {
      throw new Error("thread t-9 is not in project project-1");
    });
    useGridStore.getState().renameGrid("g-1", "Mine");
    await settle();
    expect(grids()[0]!.name).toBe("Mine");
    expect(sync.reports.join("\n")).toContain("g-1");
    expect(sync.reports.join("\n")).toContain("thread t-9 is not in project project-1");
    sync.stop();
  });
});

describe("first upload", () => {
  it("uploads the cached grids when the server has none, once", async () => {
    const sync = start();
    useGridStore.setState({
      grids: [localGrid({ id: "g-a" }), localGrid({ id: "g-b", name: "Two" })],
    });
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, []);
    await settle();
    expect(sync.puts.map((put) => [put.input.grid.id, put.input.expectedRevision])).toEqual([
      ["g-a", 0],
      ["g-b", 0],
    ]);
    expect(sync.imported.has(ENV)).toBe(true);

    sync.serverSnapshot(ENV, []);
    await settle();
    expect(sync.puts).toHaveLength(2);
    sync.stop();
  });

  it("does not upload when the import already ran for the environment", async () => {
    useGridStore.setState({ grids: [localGrid({ id: "g-a" })] });
    const sync = start();
    sync.imported.add(ENV);
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, []);
    await settle();
    expect(sync.puts).toEqual([]);
    sync.stop();
  });

  it("keeps cached grids local and unsent for an environment that is not connected", async () => {
    const sync = start();
    useGridStore.setState({ grids: [localGrid({ id: "g-a", environmentId: "env-off" })] });
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, []);
    useGridStore.getState().renameGrid("g-a", "Edited offline");
    await settle();
    expect(sync.puts).toEqual([]);
    expect(grids()[0]!.name).toBe("Edited offline");
    sync.stop();
  });

  it("uploads a grid created while its environment was disconnected once it connects", async () => {
    const sync = start();
    sync.imported.add("env-late");
    sync.connect([]);
    useGridStore.getState().createGrid({
      environmentId: "env-late",
      projectId: "project-1",
      workspaceKey: "env-late:project-1",
      id: "g-late",
    });
    await settle();
    expect(sync.puts).toEqual([]);
    sync.connect(["env-late"]);
    sync.serverSnapshot("env-late", []);
    await settle();
    expect(sync.puts.map((put) => put.input.grid.id)).toEqual(["g-late"]);
    sync.stop();
  });

  it("pushes an edit made while disconnected after the environment reconnects", async () => {
    const sync = start();
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record({ revision: 2 })]);
    sync.connect([]);
    useGridStore.getState().renameGrid("g-1", "Offline edit");
    await settle();
    expect(sync.puts).toEqual([]);
    sync.connect([ENV]);
    sync.serverSnapshot(ENV, [record({ revision: 2 })]);
    await settle();
    expect(sync.puts).toHaveLength(1);
    expect(sync.puts[0]!.input).toMatchObject({
      expectedRevision: 2,
      grid: { name: "Offline edit" },
    });
    sync.stop();
  });
});
