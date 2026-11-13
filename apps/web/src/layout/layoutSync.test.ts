import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import {
  layoutTabContentKey,
  type HoustonLayoutWorkspacePutInput,
  type HoustonLayoutWorkspacePutResult,
  type HoustonLayoutWorkspaceRecord,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLayoutState, showLayoutContent, type LayoutTabContent } from "./layoutModel";
import { tabContentToRecord as toRecordContent } from "./layoutRecords";
import { LAYOUT_CONFLICT_ATTEMPTS, LAYOUT_PUSH_DEBOUNCE_MS, startLayoutSync } from "./layoutSync";
import { useLayoutStore } from "./layoutStore";

const NOW = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const chat = (id: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(id)) },
});

type Snapshot = { workspaces: ReadonlyArray<HoustonLayoutWorkspaceRecord>; loaded: boolean };

/**
 * A composed fixture: a server with the contract's revision and one-tab-per-content rules, and a
 * stream that echoes every committed change, as the real one does.
 */
function fakeServer(initial: HoustonLayoutWorkspaceRecord[] = []) {
  const records = new Map(initial.map((record) => [record.id, record]));
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const calls: string[] = [];
  const emit = () => {
    const snapshot = { workspaces: [...records.values()], loaded: true };
    for (const listener of listeners) listener(snapshot);
  };
  const keysOutside = (id: string) =>
    new Set(
      [...records.values()]
        .filter((record) => record.id !== id)
        .flatMap((record) => record.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs)))
        .map((tab) => layoutTabContentKey(tab.content)),
    );
  return {
    records,
    calls,
    listeners,
    emit,
    watch: (listener: (snapshot: Snapshot) => void) => {
      listeners.add(listener);
      listener({ workspaces: [...records.values()], loaded: true });
      return () => listeners.delete(listener);
    },
    put: async (
      input: HoustonLayoutWorkspacePutInput,
    ): Promise<HoustonLayoutWorkspacePutResult> => {
      calls.push(`put:${input.workspace.id}@${input.expectedRevision}`);
      const current = records.get(input.workspace.id) ?? null;
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        return { status: "conflict", current };
      }
      const outside = keysOutside(input.workspace.id);
      for (const tab of input.workspace.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs))) {
        if (outside.has(layoutTabContentKey(tab.content))) {
          throw Object.assign(new Error("duplicate content"), { kind: "duplicate_content" });
        }
      }
      const saved = {
        ...input.workspace,
        position: current?.position ?? records.size,
        revision: input.expectedRevision + 1,
      };
      records.set(saved.id, saved);
      emit();
      return { status: "saved", workspace: saved };
    },
    reorder: async (ids: ReadonlyArray<string>) => {
      calls.push(`reorder:${ids.join(",")}`);
      ids.forEach((id, position) => {
        const record = records.get(id);
        if (record) records.set(id, { ...record, position });
      });
      emit();
    },
    delete: async (id: string) => {
      calls.push(`delete:${id}`);
      records.delete(id);
      emit();
    },
  };
}

const record = (id: string, position: number, threadId: string): HoustonLayoutWorkspaceRecord => ({
  id,
  name: `Name ${id}`,
  position,
  columns: [
    {
      id: `${id}-c`,
      width: 1,
      panes: [
        {
          id: `${id}-p`,
          size: 1,
          activeTabId: `${id}-t`,
          tabs: [
            {
              id: `${id}-t`,
              content: {
                kind: "chat",
                target: { kind: "server", threadRef: { environmentId: "local", threadId } },
              },
            },
          ],
        },
      ],
    },
  ],
  pinnedAt: null,
  hidden: false,
  createdAt: NOW,
  revision: 1,
  updatedAt: NOW,
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(LAYOUT_PUSH_DEBOUNCE_MS + 10);
};

let store: typeof useLayoutStore;
let reports: string[];

const start = (server: ReturnType<typeof fakeServer>) =>
  startLayoutSync({
    store,
    watchServer: server.watch,
    put: server.put,
    reorder: server.reorder,
    delete: server.delete,
    now: () => NOW,
    report: (message) => reports.push(message),
  });

beforeEach(() => {
  vi.useFakeTimers();
  reports = [];
  useLayoutStore.setState({ layout: createLayoutState(), layoutLoaded: false });
  store = useLayoutStore;
});
afterEach(() => vi.useRealTimers());

describe("layout sync", () => {
  it("shows the server's workspaces once the first snapshot arrives", () => {
    const server = fakeServer([record("a", 0, "ta"), record("b", 1, "tb")]);
    const stop = start(server);
    const state = store.getState();
    expect(state.layoutLoaded).toBe(true);
    expect(state.layout.workspaces.map((w) => w.id).slice(0, 2)).toEqual(["a", "b"]);
    stop();
  });

  it("sends a local change after it settles, with the stored revision, and never echoes the reply", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    store.getState().openKeptTab(chat("tb"));
    expect(server.calls).toEqual([]);
    await settle();
    expect(server.calls).toEqual(["put:a@1"]);
    expect(server.records.get("a")!.revision).toBe(2);
    await settle();
    expect(server.calls).toEqual(["put:a@1"]);
    stop();
  });

  it("creates a workspace the strip started with revision 0", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    const trailing = store.getState().layout.workspaces.at(-1)!;
    store.getState().focusWorkspace(trailing.id);
    store.getState().openKeptTab(chat("tb"));
    await settle();
    expect(server.calls).toContain(`put:${trailing.id}@0`);
    expect(server.records.get(trailing.id)!.name).toBe("Workspace 2");
    stop();
  });

  it("re-reads the server's revision after a conflict and saves again", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    server.records.set("a", { ...server.records.get("a")!, revision: 5 });
    store.getState().openKeptTab(chat("tb"));
    await settle();
    expect(server.calls).toEqual(["put:a@1", "put:a@5"]);
    expect(server.records.get("a")!.revision).toBe(6);
    stop();
  });

  it("recreates a workspace another client deleted", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    server.records.delete("a");
    store.getState().openKeptTab(chat("tb"));
    await settle();
    expect(server.calls).toEqual(["put:a@1", "put:a@0"]);
    expect(server.records.has("a")).toBe(true);
    stop();
  });

  it("gives up after repeated conflicts, names the workspace and shows the server's copy", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    let revision = 1;
    const put = server.put;
    const fighting = startLayoutSync({
      store,
      watchServer: server.watch,
      put: async (input) => {
        revision += 1;
        server.records.set("a", { ...server.records.get("a")!, revision });
        return put(input);
      },
      reorder: server.reorder,
      delete: server.delete,
      now: () => NOW,
      report: (message) => reports.push(message),
    });
    store.getState().openKeptTab(chat("tb"));
    await settle();
    expect(reports.join("\n")).toContain(`lost ${LAYOUT_CONFLICT_ATTEMPTS} revision races`);
    expect(reports.join("\n")).toContain("Name a");
    const tabs = store
      .getState()
      .layout.workspaces[0]!.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs));
    expect(tabs).toHaveLength(1);
    fighting();
  });

  it("applies another client's change at once and sends nothing back", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    server.records.set("b", record("b", 1, "tb"));
    server.emit();
    expect(store.getState().layout.workspaces.map((w) => w.id)).toContain("b");
    await settle();
    expect(server.calls).toEqual([]);
    stop();
  });

  it("saves a tab moved between workspaces out of its old workspace first", async () => {
    const server = fakeServer([record("a", 0, "ta"), record("b", 1, "tb")]);
    const stop = start(server);
    const tab = store.getState().layout.workspaces[0]!.columns[0]!.panes[0]!.tabs[0]!;
    // Opening the chat of workspace a's tab inside workspace b moves it there.
    store.getState().moveTab(tab.id, {
      kind: "pane",
      paneId: "b-p",
    });
    await settle();
    const ids = (id: string) =>
      server.records
        .get(id)
        ?.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs.map((t) => t.id))) ?? [];
    expect(ids("b")).toContain("a-t");
    expect(ids("a")).not.toContain("a-t");
    expect(reports).toEqual([]);
    stop();
  });

  it("empties a closed workspace before deleting it so its tabs do not come back", async () => {
    const server = fakeServer([record("a", 0, "ta"), record("b", 1, "tb")]);
    const stop = start(server);
    store.getState().closeTab("b-t");
    await settle();
    expect(server.calls).toEqual(["put:b@1", "delete:b"]);
    expect([...server.records.keys()]).toEqual(["a"]);
    stop();
  });

  it("saves a new workspace order with the stored ids", async () => {
    const server = fakeServer([record("a", 0, "ta"), record("b", 1, "tb")]);
    const stop = start(server);
    store.getState().focusWorkspace("b");
    store.getState().moveWorkspace(-1);
    await settle();
    expect(server.calls).toEqual(["reorder:b,a"]);
    stop();
  });

  it("keeps the ghost mark of a tab across the server's echo and never stores it", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    const before = store.getState().layout;
    store.getState().commitDerived(before, showLayoutContent(before, chat("tb")), (l) => l);
    await settle();
    const tabs = store
      .getState()
      .layout.workspaces[0]!.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs));
    const ghost = tabs.find(
      (tab) => layoutTabContentKey(toRecordContent(tab.content)) === "chat:local:tb",
    );
    expect(ghost?.ghostOf).not.toBeUndefined();
    expect(JSON.stringify([...server.records.values()])).not.toContain("ghostOf");
    stop();
  });

  it("rule 11: a server-side move survives a local put computed from older state", async () => {
    const server = fakeServer([record("a", 0, "ta"), record("b", 1, "tb")]);
    const stop = start(server);
    // A tab the server will move: it sits in workspace a, which the window then edits.
    const a = server.records.get("a")!;
    const moving = {
      id: "a-tm",
      content: toRecordContent(chat("tm")),
    };
    const withMoving = {
      ...a,
      revision: 2,
      columns: [
        {
          ...a.columns[0]!,
          panes: [{ ...a.columns[0]!.panes[0]!, tabs: [...a.columns[0]!.panes[0]!.tabs, moving] }],
        },
      ],
    };
    server.records.set("a", withMoving);
    server.emit();
    // The window edits workspace a; its push waits for the debounce.
    store.getState().openKeptTab(chat("tc"));
    // Before it fires, the server moves tm to workspace b, bumping both revisions.
    const b = server.records.get("b")!;
    server.records.set("a", { ...a, revision: 3 });
    server.records.set("b", {
      ...b,
      revision: 2,
      columns: [
        {
          ...b.columns[0]!,
          panes: [{ ...b.columns[0]!.panes[0]!, tabs: [...b.columns[0]!.panes[0]!.tabs, moving] }],
        },
      ],
    });
    server.emit();
    await settle();
    const tabsOf = (id: string) =>
      server.records
        .get(id)!
        .columns.flatMap((c) => c.panes.flatMap((p) => p.tabs.map((t) => t.id)));
    expect(tabsOf("b")).toContain("a-tm");
    expect(tabsOf("a")).not.toContain("a-tm");
    expect(server.calls.filter((call) => call.startsWith("put:a@"))).toEqual([]);
    const local = store
      .getState()
      .layout.workspaces.flatMap((w) => w.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs)));
    expect(local.filter((tab) => tab.id === "a-tm")).toHaveLength(1);
    stop();
  });

  it("rule 11: a save that meets a server-side move shows the server's copy and says so", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    store.getState().openKeptTab(chat("tc"));
    // The put is already on its way when the server's move lands: the revision it carries is stale.
    const a = server.records.get("a")!;
    server.records.set("a", { ...a, revision: 2, name: "Moved by the server" });
    await settle();
    expect(server.records.get("a")!.name).toBe("Moved by the server");
    expect(reports.join("\n")).toContain("changed on the server");
    expect(store.getState().layout.workspaces[0]!.name).toBe("Moved by the server");
    stop();
  });

  it("flush sends a pending change at once", async () => {
    const server = fakeServer([record("a", 0, "ta")]);
    const stop = start(server);
    store.getState().openKeptTab(chat("tc"));
    await stop.flush();
    expect(server.calls).toEqual(["put:a@1"]);
    stop();
  });
});
