import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  type LayoutState,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { createLayoutWorkspaceNamed } from "../../layout/layoutWorkspaces";
import { buildSidebarWorkspaceSections } from "./sidebarWorkspaceSections";

const NOW = "2026-06-01T12:00:00.000Z";
const environmentId = EnvironmentId.make("env-1");

function thread(id: string, projectId = "p1", overrides: Partial<EnvironmentThreadShell> = {}) {
  return {
    id,
    environmentId: "env-1",
    projectId,
    title: id,
    branch: null,
    pullRequests: [],
    branchPullRequest: null,
    providerInstanceId: "claude",
    snoozedUntil: null,
    settledOverride: null,
    archivedAt: null,
    deletedAt: null,
    pinnedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestRun: null,
    runtime: null,
    autoSettleDisabledAt: null,
    lastVisitedAt: null,
    unsettledAt: null,
    lineage: {
      relationshipToParent: null,
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      sideChat: false,
    },
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const chat = (id: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(id)) },
});

/** Workspaces from `[name, chat ids]`; each starts as the empty trailing workspace and fills. */
function layoutOf(spec: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): LayoutState {
  let state = createLayoutState();
  for (const [name, ids] of spec) {
    state = createLayoutWorkspaceNamed(state, name).state;
    for (const id of ids) state = openLayoutTab(state, chat(id), { placement: "new-column" });
    state = normalizeLayout(state);
  }
  return state;
}

const base = {
  nowIso: NOW,
  query: "",
  threadSort: "grid" as const,
  projectKeys: null,
  excludedThreadIds: undefined,
};
const ids = (threads: ReadonlyArray<EnvironmentThreadShell>) => threads.map((t) => t.id);

describe("buildSidebarWorkspaceSections", () => {
  it("lists one workspace with the threads whose chat tab it holds, in tab order", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([["Today", ["b", "a"]]]),
      threads: [thread("a"), thread("b"), thread("c-not-open")],
    });
    expect(sections.map((s) => s.name)).toEqual(["Today"]);
    expect(ids(sections[0]!.threads)).toEqual(["b", "a", "c-not-open"]);
  });

  it("lists several workspaces in the layout's order and keeps each thread under its own", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([
        ["First", ["a"]],
        ["Second", ["b", "c"]],
      ]),
      threads: [thread("a"), thread("b"), thread("c")],
    });
    expect(sections.map((s) => [s.name, ids(s.threads)])).toEqual([
      ["First", ["a"]],
      ["Second", ["b", "c"]],
    ]);
  });

  it("lets one workspace hold threads of two projects", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([["Mixed", ["a", "b"]]]),
      threads: [thread("a", "p1"), thread("b", "p2")],
    });
    expect(sections[0]!.threads.map((t) => t.projectId)).toEqual(["p1", "p2"]);
  });

  it("lists the empty workspace the user is on, with no threads, and not the unfocused trailing one", () => {
    const layout = layoutOf([["Full", ["a"]]]);
    expect(
      buildSidebarWorkspaceSections({ ...base, layout, threads: [thread("a")] }).sections,
    ).toHaveLength(1);
    const onEmpty = createLayoutWorkspaceNamed(layout, "Blank").state;
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: onEmpty,
      threads: [thread("a")],
    });
    expect(sections.map((s) => [s.name, s.threads.length])).toEqual([
      ["Full", 1],
      ["Blank", 0],
    ]);
  });

  it("puts a thread whose chat is in no workspace under the first one and reports it", () => {
    const result = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([
        ["First", ["a"]],
        ["Second", ["b"]],
      ]),
      threads: [thread("a"), thread("b"), thread("loose")],
    });
    expect(ids(result.sections[0]!.threads)).toEqual(["a", "loose"]);
    expect(ids(result.sections[1]!.threads)).toEqual(["b"]);
    expect(result.unplacedThreadIds).toEqual(["loose"]);
  });

  it("ignores a draft chat and surface tabs when placing threads", () => {
    let layout = layoutOf([["Only", ["a"]]]);
    layout = openLayoutTab(layout, {
      kind: "surface",
      threadRef: scopeThreadRef(environmentId, ThreadId.make("b")),
      surfaceId: "diff",
    });
    const { sections, unplacedThreadIds } = buildSidebarWorkspaceSections({
      ...base,
      layout,
      threads: [thread("a"), thread("b")],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a", "b"]);
    expect(unplacedThreadIds).toEqual(["b"]);
  });

  it("leaves out archived, deleted, closed, held and subagent threads", () => {
    const hidden = [
      thread("archived", "p1", { archivedAt: NOW }),
      thread("deleted", "p1", { deletedAt: NOW }),
      thread("closed", "p1", { settledOverride: "settled" }),
      thread("held", "p1", { snoozedUntil: "2026-06-02T00:00:00.000Z" }),
      thread("child", "p1", {
        lineage: {
          relationshipToParent: "subagent",
          parentThreadId: ThreadId.make("a"),
          rootThreadId: ThreadId.make("a"),
          sideChat: false,
        },
      } as Partial<EnvironmentThreadShell>),
    ];
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([["W", ["a"]]]),
      threads: [thread("a"), ...hidden],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });

  it("leaves out threads of projects outside the filter", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      projectKeys: new Set(["env-1:p1"]),
      layout: layoutOf([["W", ["a", "b"]]]),
      threads: [thread("a", "p1"), thread("b", "p2")],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });

  it("lists pinned workspaces first and hidden ones apart, each keeping layout order", () => {
    const layout = layoutOf([
      ["One", ["a"]],
      ["Two", ["b"]],
      ["Three", ["c"]],
      ["Four", ["d"]],
    ]);
    const marked: LayoutState = {
      ...layout,
      workspaces: layout.workspaces.map((w) =>
        w.name === "Three"
          ? { ...w, pinnedAt: NOW }
          : w.name === "Two"
            ? { ...w, hidden: true }
            : w,
      ),
    };
    const result = buildSidebarWorkspaceSections({
      ...base,
      layout: marked,
      threads: [thread("a"), thread("b"), thread("c"), thread("d")],
    });
    expect(result.sections.map((s) => s.name)).toEqual(["Three", "One", "Four"]);
    expect(result.sections[0]!.pinned).toBe(true);
    expect(result.hiddenSections.map((s) => s.name)).toEqual(["Two"]);
  });

  it("names an unnamed workspace by the resolver, else by its place", () => {
    let layout = openLayoutTab(createLayoutState(), chat("a"));
    layout = normalizeLayout(layout);
    const resolved = buildSidebarWorkspaceSections({
      ...base,
      layout,
      threads: [thread("a")],
      resolveWorkspaceTitle: () => "Lead tab",
    });
    expect(resolved.sections[0]!.name).toBe("Lead tab");
    const placed = buildSidebarWorkspaceSections({ ...base, layout, threads: [thread("a")] });
    expect(placed.sections[0]!.name).toBe("Workspace 1");
  });

  it("orders rows by the sort setting and puts pinned threads first", () => {
    const threads = [
      thread("old", "p1", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      thread("new", "p1", { updatedAt: "2026-05-01T00:00:00.000Z" }),
      thread("pinned", "p1", {
        updatedAt: "2026-02-01T00:00:00.000Z",
        pinnedAt: NOW,
      } as Partial<EnvironmentThreadShell>),
    ];
    const layout = layoutOf([["W", ["old", "new", "pinned"]]]);
    expect(
      ids(buildSidebarWorkspaceSections({ ...base, layout, threads }).sections[0]!.threads),
    ).toEqual(["pinned", "old", "new"]);
    expect(
      ids(
        buildSidebarWorkspaceSections({ ...base, threadSort: "updated_at", layout, threads })
          .sections[0]!.threads,
      ),
    ).toEqual(["pinned", "new", "old"]);
  });

  describe("search", () => {
    const layout = layoutOf([
      ["Alpha", ["a", "b"]],
      ["Beta", ["c"]],
    ]);
    const threads = [
      thread("a", "p1", { title: "Fix login" }),
      thread("b", "p1", { title: "Docs" }),
      thread("c", "p1", { title: "Other" }),
    ];

    it("keeps matching threads and drops workspaces with none", () => {
      const { sections } = buildSidebarWorkspaceSections({
        ...base,
        layout,
        threads,
        query: "login",
      });
      expect(sections.map((s) => [s.name, ids(s.threads)])).toEqual([["Alpha", ["a"]]]);
    });

    it("shows every thread of a workspace whose name matches", () => {
      const { sections } = buildSidebarWorkspaceSections({
        ...base,
        layout,
        threads,
        query: "beta",
      });
      expect(sections.map((s) => [s.name, ids(s.threads)])).toEqual([["Beta", ["c"]]]);
    });

    it("searches only workspaces that are shown", () => {
      const hidden: LayoutState = {
        ...layout,
        workspaces: layout.workspaces.map((w) => (w.name === "Alpha" ? { ...w, hidden: true } : w)),
      };
      const result = buildSidebarWorkspaceSections({
        ...base,
        layout: hidden,
        threads,
        query: "login",
      });
      expect(result.sections).toEqual([]);
    });
  });

  it("lifts the threads Needs you lists out of their workspace and counts them", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      layout: layoutOf([["W", ["a", "b"]]]),
      threads: [thread("a"), thread("b")],
      excludedThreadIds: new Set(["a"]),
    });
    expect(ids(sections[0]!.threads)).toEqual(["b"]);
    expect(ids(sections[0]!.needsYouThreads)).toEqual(["a"]);
  });

  it("keeps those threads in their workspace while searching", () => {
    const { sections } = buildSidebarWorkspaceSections({
      ...base,
      query: "a",
      layout: layoutOf([["W", ["a"]]]),
      threads: [thread("a")],
      excludedThreadIds: new Set(["a"]),
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });
});
