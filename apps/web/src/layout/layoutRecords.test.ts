import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import type { HoustonLayoutWorkspaceRecord } from "@houston-app/contracts/houston/layoutWorkspaces";
import { describe, expect, it } from "vite-plus/test";

import {
  layoutRecordContentKey,
  layoutStateFromRecords,
  layoutStateToRecords,
  type KnownLayoutRecord,
} from "./layoutRecords";
import {
  createLayoutState,
  type LayoutState,
  type LayoutTab,
  type LayoutTabContent,
  type LayoutWorkspace,
} from "./layoutModel";

const environmentId = EnvironmentId.make("local");
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
const chat = (id: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: ref(id) },
});
const tab = (id: string, content: LayoutTabContent, ghost = false): LayoutTab => ({
  id,
  content,
  ...(ghost ? { ghostOf: null } : {}),
});

const workspace = (
  id: string,
  columns: LayoutWorkspace["columns"],
  extra: Partial<LayoutWorkspace> = {},
): LayoutWorkspace => ({
  id,
  name: null,
  columns,
  focusedPaneId: columns[0]?.panes[0]?.id ?? null,
  cameraWidth: null,
  ...extra,
});
const column = (id: string, tabs: LayoutTab[], width = 1) => ({
  id,
  width,
  panes: [{ id: `${id}-pane`, size: 1, activeTabId: tabs[0]!.id, tabs }],
});

const NOW = "2026-01-01T00:00:00.000Z";
const stateOf = (workspaces: LayoutWorkspace[], focused = workspaces[0]!.id): LayoutState => ({
  workspaces,
  focusedWorkspaceId: focused,
});

describe("layoutStateToRecords", () => {
  it("stores every tab kind with its page shape and drops client-only ghost marks", () => {
    const content: LayoutTabContent[] = [
      chat("a"),
      { kind: "surface", threadRef: ref("a"), surfaceId: "diff" },
      { kind: "launcher", id: "launcher:1", context: null },
      { kind: "pull-requests", href: "/pull-requests" },
      { kind: "tasks", href: "/tasks?view=queue" },
    ];
    const tabs = content.map((c, i) => tab(`t${i}`, c, i === 0));
    const records = layoutStateToRecords(
      stateOf([workspace("w1", [column("c1", tabs)])]),
      new Map(),
      NOW,
    );
    expect(records).toHaveLength(1);
    const stored = records[0]!.columns[0]!.panes[0]!.tabs;
    expect(stored.map((t) => t.content.kind)).toEqual([
      "chat",
      "surface",
      "launcher",
      "page",
      "page",
    ]);
    expect(stored[3]!.content).toEqual({
      kind: "page",
      page: "pull-requests",
      href: "/pull-requests",
    });
    expect(stored[4]!.content).toEqual({ kind: "page", page: "tasks", href: "/tasks?view=queue" });
    expect(JSON.stringify(records)).not.toContain("ghostOf");
  });

  it("leaves out the trailing empty workspace while another workspace holds tabs", () => {
    const state = stateOf([
      workspace("w1", [column("c1", [tab("t1", chat("a"))])]),
      workspace("w2", []),
    ]);
    expect(layoutStateToRecords(state, new Map(), NOW).map((r) => r.id)).toEqual(["w1"]);
  });

  it("keeps one empty workspace when nothing else exists", () => {
    const records = layoutStateToRecords(createLayoutState(), new Map(), NOW);
    expect(records).toHaveLength(1);
    expect(records[0]!.columns).toEqual([]);
  });

  it("names an unnamed workspace by its place and reuses the stored name afterwards", () => {
    const state = stateOf([
      workspace("w1", [column("c1", [tab("t1", chat("a"))])]),
      workspace("w2", [column("c2", [tab("t2", chat("b"))])], { name: "Mine" }),
    ]);
    const known = new Map<string, KnownLayoutRecord>([
      ["w1", { name: "Renamed on server", createdAt: "2025-01-01T00:00:00.000Z" }],
    ]);
    const [first, second] = layoutStateToRecords(state, known, NOW);
    expect(first!.name).toBe("Renamed on server");
    expect(second!.name).toBe("Mine");
    const fresh = layoutStateToRecords(state, new Map(), NOW);
    expect(fresh[0]!.name).toBe("Workspace 1");
    expect(fresh[0]!.createdAt).toBe(NOW);
  });

  it("stores a column wider than the strip at full width, the widest the record can hold", () => {
    const state = stateOf([workspace("w1", [column("c1", [tab("t1", chat("a"))], 1.4)])]);
    expect(layoutStateToRecords(state, new Map(), NOW)[0]!.columns[0]!.width).toBe(1);
  });

  it("truncates a name past the limit instead of failing the save", () => {
    const state = stateOf([
      workspace("w1", [column("c1", [tab("t1", chat("a"))])], { name: "x".repeat(300) }),
    ]);
    expect(layoutStateToRecords(state, new Map(), NOW)[0]!.name).toHaveLength(120);
  });
});

describe("layoutStateFromRecords", () => {
  const record = (
    id: string,
    position: number,
    tabIds: string[],
  ): HoustonLayoutWorkspaceRecord => ({
    id,
    name: `Name ${id}`,
    position,
    columns: [
      {
        id: `${id}-c`,
        width: 0.5,
        panes: [
          {
            id: `${id}-p`,
            size: 1,
            activeTabId: tabIds[0]!,
            tabs: tabIds.map((t) => ({
              id: t,
              content: {
                kind: "chat" as const,
                target: {
                  kind: "server" as const,
                  threadRef: { environmentId: "local", threadId: t },
                },
              },
            })),
          },
        ],
      },
    ],
    pinnedAt: null,
    hidden: false,
    createdAt: NOW,
    revision: 3,
    updatedAt: NOW,
  });

  it("orders workspaces by position and appends the empty trailing workspace", () => {
    const state = layoutStateFromRecords(
      [record("b", 1, ["tb"]), record("a", 0, ["ta"])],
      null,
      new Set(),
    );
    expect(state.workspaces.map((w) => w.id).slice(0, 2)).toEqual(["a", "b"]);
    expect(state.workspaces.at(-1)!.columns).toEqual([]);
    expect(state.workspaces[0]!.name).toBe("Name a");
  });

  it("keeps focus, camera width and ghost marks the window owns", () => {
    const previous: LayoutState = {
      workspaces: [
        workspace("a", [column("a-c", [tab("ta", chat("ta"), true)])], {
          cameraWidth: 1200,
          focusedPaneId: "a-p",
        }),
      ],
      focusedWorkspaceId: "a",
    };
    const state = layoutStateFromRecords([record("a", 0, ["ta"])], previous, new Set(["ta"]));
    const a = state.workspaces[0]!;
    expect(a.cameraWidth).toBe(1200);
    expect(a.focusedPaneId).toBe("a-p");
    expect(a.columns[0]!.panes[0]!.tabs[0]!.ghostOf).toBeNull();
    expect(state.focusedWorkspaceId).toBe("a");
  });

  it("moves focus to the first workspace when the focused one is gone", () => {
    const previous = stateOf([workspace("gone", [column("g", [tab("tg", chat("tg"))])])]);
    const state = layoutStateFromRecords([record("a", 0, ["ta"])], previous, new Set());
    expect(state.focusedWorkspaceId).toBe("a");
  });

  it("round-trips the stored content", () => {
    const original = [record("a", 0, ["ta", "tb"])];
    const back = layoutStateToRecords(
      layoutStateFromRecords(original, null, new Set()),
      new Map([["a", { name: "Name a", createdAt: NOW }]]),
      NOW,
    );
    expect(layoutRecordContentKey(back[0]!)).toBe(layoutRecordContentKey(original[0]!));
  });

  it("keeps a workspace's pin and hidden state through a round trip and counts them as content", () => {
    const pinned = { ...record("a", 0, ["ta"]), pinnedAt: NOW, hidden: true };
    const state = layoutStateFromRecords([pinned], null, new Set());
    expect(state.workspaces[0]).toMatchObject({ pinnedAt: NOW, hidden: true });
    const [back] = layoutStateToRecords(
      state,
      new Map([["a", { name: "Name a", createdAt: NOW }]]),
      NOW,
    );
    expect(back).toMatchObject({ pinnedAt: NOW, hidden: true });
    expect(layoutRecordContentKey(back!)).toBe(layoutRecordContentKey(pinned));
    expect(layoutRecordContentKey(pinned)).not.toBe(layoutRecordContentKey(record("a", 0, ["ta"])));
  });

  it("yields the default empty layout for no records", () => {
    expect(layoutStateFromRecords([], null, new Set()).workspaces).toHaveLength(1);
  });
});

describe("a stored layout that still holds a Usage page tab", () => {
  const paneRecord = (
    id: string,
    size: number,
    tabs: { id: string; content: unknown }[],
    activeTabId: string,
  ) => ({ id, size, activeTabId, tabs });
  const chatRecord = (id: string) => ({
    id,
    content: {
      kind: "chat",
      target: { kind: "server", threadRef: { environmentId: "local", threadId: id } },
    },
  });
  const usageRecord = (id: string) => ({ id, content: { kind: "page", page: "usage" } });
  const recordOf = (columns: unknown[]) =>
    ({
      id: "w1",
      name: "One",
      position: 0,
      columns,
      pinnedAt: null,
      hidden: false,
      createdAt: NOW,
      revision: 1,
      updatedAt: NOW,
    }) as unknown as HoustonLayoutWorkspaceRecord;

  it("drops the tab and activates the pane's first remaining tab", () => {
    const state = layoutStateFromRecords(
      [
        recordOf([
          {
            id: "c1",
            width: 1,
            panes: [paneRecord("p1", 1, [usageRecord("t-usage"), chatRecord("t-chat")], "t-usage")],
          },
        ]),
      ],
      null,
      new Set(),
    );
    const pane = state.workspaces[0]!.columns[0]!.panes[0]!;
    expect(pane.tabs.map((entry) => entry.id)).toEqual(["t-chat"]);
    expect(pane.activeTabId).toBe("t-chat");
  });

  it("drops a Settings tab the same way", () => {
    const state = layoutStateFromRecords(
      [
        recordOf([
          {
            id: "c1",
            width: 1,
            panes: [
              paneRecord(
                "p1",
                1,
                [
                  { id: "t-settings", content: { kind: "page", page: "settings" } },
                  chatRecord("t-chat"),
                ],
                "t-settings",
              ),
            ],
          },
        ]),
      ],
      null,
      new Set(),
    );
    const pane = state.workspaces[0]!.columns[0]!.panes[0]!;
    expect(pane.tabs.map((entry) => entry.id)).toEqual(["t-chat"]);
    expect(pane.activeTabId).toBe("t-chat");
  });

  it("collapses a pane whose only tab was Usage and rescales the pane beside it", () => {
    const state = layoutStateFromRecords(
      [
        recordOf([
          {
            id: "c1",
            width: 1,
            panes: [
              paneRecord("p1", 0.5, [chatRecord("t-chat")], "t-chat"),
              paneRecord("p2", 0.5, [usageRecord("t-usage")], "t-usage"),
            ],
          },
        ]),
      ],
      null,
      new Set(),
    );
    const panes = state.workspaces[0]!.columns[0]!.panes;
    expect(panes.map((pane) => [pane.id, pane.size])).toEqual([["p1", 1]]);
  });

  it("leaves a workspace that held only Usage empty instead of failing the load", () => {
    const state = layoutStateFromRecords(
      [
        recordOf([
          {
            id: "c1",
            width: 1,
            panes: [paneRecord("p1", 1, [usageRecord("t-usage")], "t-usage")],
          },
        ]),
      ],
      null,
      new Set(),
    );
    expect(state.workspaces.flatMap((entry) => entry.columns)).toEqual([]);
  });
});
