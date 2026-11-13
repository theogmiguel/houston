import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOUSTON_LAYOUT_WORKSPACE_LIMITS as LIMITS,
  HoustonLayoutWorkspacePutInput,
  HoustonLayoutWorkspaceRecord,
  HoustonLayoutWorkspaceStreamEvent,
  layoutTabContentKey,
} from "./layoutWorkspaces.ts";

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success";

const tab = (n: number, content?: unknown) => ({
  id: `tab-${n}`,
  content: content ?? {
    kind: "chat",
    target: { kind: "server", threadRef: { environmentId: "env", threadId: `t${n}` } },
  },
});
const pane = (n: number, tabs = [tab(n)]) => ({
  id: `pane-${n}`,
  size: 1,
  activeTabId: tabs[0]!.id,
  tabs,
});
const column = (n: number) => ({ id: `col-${n}`, width: 1, panes: [pane(n)] });
const record = (overrides: Record<string, unknown> = {}) => ({
  id: "w1",
  name: "Main",
  position: 0,
  columns: [column(1)],
  pinnedAt: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  revision: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("HoustonLayoutWorkspaceRecord", () => {
  it("accepts every durable tab content kind", () => {
    const contents = [
      { kind: "chat", target: { kind: "draft", draftId: "d1" } },
      { kind: "surface", threadRef: { environmentId: "env", threadId: "t1" }, surfaceId: "diff" },
      { kind: "launcher", id: "l1", context: null },
      { kind: "page", page: "settings", href: "/settings/general" },
    ];
    const tabs = contents.map((content, n) => tab(n, content));
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({ columns: [{ ...column(1), panes: [pane(1, tabs)] }] }),
      ),
    ).toBe(true);
  });

  it("refuses an unknown content kind or page", () => {
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({ columns: [{ ...column(1), panes: [pane(1, [tab(1, { kind: "ghost" })])] }] }),
      ),
    ).toBe(false);
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({
          columns: [{ ...column(1), panes: [pane(1, [tab(1, { kind: "page", page: "nope" })])] }],
        }),
      ),
    ).toBe(false);
  });

  it("holds each size bound at its limit and refuses one past it", () => {
    const columns = (n: number) => Array.from({ length: n }, (_, i) => column(i));
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ columns: columns(LIMITS.columns) })),
    ).toBe(true);
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ columns: columns(LIMITS.columns + 1) })),
    ).toBe(false);
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ name: "x".repeat(LIMITS.nameChars) })),
    ).toBe(true);
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ name: "x".repeat(LIMITS.nameChars + 1) })),
    ).toBe(false);
    const tabs = (n: number) => Array.from({ length: n }, (_, i) => tab(i));
    const withTabs = (n: number) =>
      record({ columns: [{ ...column(1), panes: [pane(1, tabs(n))] }] });
    expect(accepts(HoustonLayoutWorkspaceRecord, withTabs(LIMITS.tabsPerPane))).toBe(true);
    expect(accepts(HoustonLayoutWorkspaceRecord, withTabs(LIMITS.tabsPerPane + 1))).toBe(false);
  });

  it("refuses an empty pane, an empty column and an active tab outside its pane", () => {
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ columns: [{ ...column(1), panes: [] }] })),
    ).toBe(false);
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({ columns: [{ ...column(1), panes: [{ ...pane(1), tabs: [] }] }] }),
      ),
    ).toBe(false);
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({ columns: [{ ...column(1), panes: [{ ...pane(1), activeTabId: "other" }] }] }),
      ),
    ).toBe(false);
  });

  it("refuses two tabs showing the same content and a repeated id", () => {
    const same = { ...column(1), panes: [pane(1, [tab(1), { ...tab(1), id: "tab-2" }])] };
    expect(accepts(HoustonLayoutWorkspaceRecord, record({ columns: [same] }))).toBe(false);
    expect(
      accepts(
        HoustonLayoutWorkspaceRecord,
        record({ columns: [column(1), { ...column(2), id: "col-1" }] }),
      ),
    ).toBe(false);
  });

  it("refuses a share outside (0, 1]", () => {
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ columns: [{ ...column(1), width: 0 }] })),
    ).toBe(false);
    expect(
      accepts(HoustonLayoutWorkspaceRecord, record({ columns: [{ ...column(1), width: 1.5 }] })),
    ).toBe(false);
  });
});

describe("layoutTabContentKey", () => {
  it("separates chat, surface, page and launcher content", () => {
    const keys = [
      layoutTabContentKey({
        kind: "chat",
        target: { kind: "server", threadRef: { environmentId: "e", threadId: "t" } },
      }),
      layoutTabContentKey({ kind: "chat", target: { kind: "draft", draftId: "t" } }),
      layoutTabContentKey({
        kind: "surface",
        threadRef: { environmentId: "e", threadId: "t" },
        surfaceId: "diff",
      }),
      layoutTabContentKey({ kind: "page", page: "usage" }),
      layoutTabContentKey({ kind: "launcher", id: "t", context: null }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("payloads", () => {
  it("a put carries the workspace and the revision it was read at", () => {
    expect(
      accepts(HoustonLayoutWorkspacePutInput, { workspace: record(), expectedRevision: 1 }),
    ).toBe(true);
    expect(accepts(HoustonLayoutWorkspacePutInput, { workspace: record() })).toBe(false);
  });

  it("the stream carries a snapshot, an upsert or a delete", () => {
    expect(
      accepts(HoustonLayoutWorkspaceStreamEvent, {
        snapshot: { workspaces: [record()], memberships: [] },
      }),
    ).toBe(true);
    expect(
      accepts(HoustonLayoutWorkspaceStreamEvent, { snapshot: { workspaces: [record()] } }),
    ).toBe(false);
    expect(accepts(HoustonLayoutWorkspaceStreamEvent, { upserted: record() })).toBe(true);
    expect(accepts(HoustonLayoutWorkspaceStreamEvent, { deleted: { workspaceId: "w1" } })).toBe(
      true,
    );
    expect(accepts(HoustonLayoutWorkspaceStreamEvent, { deleted: {} })).toBe(false);
  });

  it("the stream carries a thread's workspace and its removal", () => {
    const membership = {
      environmentId: "env",
      threadId: "t1",
      workspaceId: "w1",
      parentThreadId: null,
    };
    expect(accepts(HoustonLayoutWorkspaceStreamEvent, { membership })).toBe(true);
    expect(
      accepts(HoustonLayoutWorkspaceStreamEvent, {
        membershipRemoved: { environmentId: "env", threadId: "t1" },
      }),
    ).toBe(true);
    expect(accepts(HoustonLayoutWorkspaceStreamEvent, { membership: { threadId: "t1" } })).toBe(
      false,
    );
  });
});
