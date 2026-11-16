import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  replaceLayoutTabContent,
  type LayoutState,
  type LayoutTabContent,
} from "../../layout/layoutModel";
import { createLayoutWorkspaceNamed } from "../../layout/layoutWorkspaces";
import { membershipKeyOf, type ThreadMembershipState } from "../../layout/threadMembership";
import {
  buildSidebarWorkspaceSections,
  createSidebarRowOrderMemory,
  type SidebarWorkspaceSectionsInput,
} from "./sidebarWorkspaceSections";

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

/**
 * The memberships a server would hold for `layout`: each thread with a chat tab belongs to that
 * tab's workspace, and `extra` places threads that have no tab, by workspace name.
 */
function membershipsOf(
  layout: LayoutState,
  extra: Readonly<Record<string, string>> = {},
): ThreadMembershipState {
  const byThread = new Map<string, { workspaceId: string; parentThreadId: string | null }>();
  for (const workspace of layout.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind !== "chat" || tab.content.target.kind !== "server") continue;
          const ref = tab.content.target.threadRef;
          byThread.set(membershipKeyOf(ref.environmentId, ref.threadId), {
            workspaceId: workspace.id,
            parentThreadId: null,
          });
        }
      }
    }
  }
  for (const [threadId, name] of Object.entries(extra)) {
    const workspace = layout.workspaces.find((candidate) => candidate.name === name);
    byThread.set(membershipKeyOf(environmentId, threadId), {
      workspaceId: workspace?.id ?? name,
      parentThreadId: null,
    });
  }
  return { loaded: true, byThread, occupied: new Set() };
}

type BuildInput = Omit<SidebarWorkspaceSectionsInput, "memberships"> & {
  readonly memberships?: ThreadMembershipState;
  readonly extra?: Readonly<Record<string, string>>;
};
const build = ({ memberships, extra, ...input }: BuildInput) =>
  buildSidebarWorkspaceSections({
    ...input,
    memberships: memberships ?? membershipsOf(input.layout, extra),
  });

const base = {
  nowIso: NOW,
  query: "",
  threadSort: "grid" as const,
  projectKeys: null,
  excludedThreadIds: undefined,
};
const ids = (threads: ReadonlyArray<EnvironmentThreadShell>) => threads.map((t) => t.id);

describe("buildSidebarWorkspaceSections", () => {
  it("lists one workspace with its threads, those with an open tab first and in tab order", () => {
    const { sections } = build({
      ...base,
      layout: layoutOf([["Today", ["b", "a"]]]),
      extra: { "c-not-open": "Today" },
      threads: [thread("a"), thread("b"), thread("c-not-open")],
    });
    expect(sections.map((s) => s.name)).toEqual(["Today"]);
    expect(ids(sections[0]!.threads)).toEqual(["b", "a", "c-not-open"]);
  });

  it("keeps two threads in place while one tab alternates between them", () => {
    const withA = layoutOf([["Today", ["a"]]]);
    const tabId = withA.workspaces[0]!.columns[0]!.panes[0]!.tabs[0]!.id;
    const withB = replaceLayoutTabContent(withA, tabId, chat("b"));
    const memberships = membershipsOf(withA, { b: "Today" });
    const rowOrder = createSidebarRowOrderMemory();
    const rows = (layout: LayoutState) =>
      ids(
        build({ ...base, layout, memberships, rowOrder, threads: [thread("b"), thread("a")] })
          .sections[0]!.threads,
      );
    expect(rows(withA)).toEqual(["a", "b"]);
    expect(rows(withB)).toEqual(["a", "b"]);
    expect(rows(withA)).toEqual(["a", "b"]);
  });

  it("lists several workspaces in the layout's order and keeps each thread under its own", () => {
    const { sections } = build({
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
    const { sections } = build({
      ...base,
      layout: layoutOf([["Mixed", ["a", "b"]]]),
      threads: [thread("a", "p1"), thread("b", "p2")],
    });
    expect(sections[0]!.threads.map((t) => t.projectId)).toEqual(["p1", "p2"]);
  });

  it("lists the empty workspace the user is on, with no threads, and not the unfocused trailing one", () => {
    const layout = layoutOf([["Full", ["a"]]]);
    expect(build({ ...base, layout, threads: [thread("a")] }).sections).toHaveLength(1);
    const onEmpty = createLayoutWorkspaceNamed(layout, "Blank").state;
    const { sections } = build({
      ...base,
      layout: onEmpty,
      threads: [thread("a")],
    });
    expect(sections.map((s) => [s.name, s.threads.length])).toEqual([
      ["Full", 1],
      ["Blank", 0],
    ]);
  });

  it("rule 9: a thread with no tab open stays under the workspace it belongs to", () => {
    const result = build({
      ...base,
      layout: layoutOf([
        ["First", ["a"]],
        ["Second", ["b"]],
      ]),
      extra: { loose: "Second" },
      threads: [thread("a"), thread("b"), thread("loose")],
    });
    expect(ids(result.sections[0]!.threads)).toEqual(["a"]);
    expect(ids(result.sections[1]!.threads)).toEqual(["b", "loose"]);
  });

  it("does not list a thread the server has not placed yet, nor jump it under the first workspace", () => {
    const layout = layoutOf([
      ["First", ["a"]],
      ["Second", ["b"]],
    ]);
    const input = { ...base, layout, threads: [thread("a"), thread("b"), thread("new")] };
    const before = build(input);
    expect(before.sections.flatMap((s) => ids(s.threads))).toEqual(["a", "b"]);
    const after = build({ ...input, extra: { new: "Second" } });
    expect(ids(after.sections[0]!.threads)).toEqual(["a"]);
    expect(ids(after.sections[1]!.threads)).toEqual(["b", "new"]);
  });

  it("lists nothing before the first membership snapshot arrives", () => {
    const layout = layoutOf([["First", ["a"]]]);
    const { sections } = build({
      ...base,
      layout,
      memberships: { loaded: false, byThread: new Map(), occupied: new Set() },
      threads: [thread("a")],
    });
    expect(sections.map((s) => s.threads.length)).toEqual([0]);
  });

  it("ignores a membership whose thread is not loaded and one whose workspace is not in the layout", () => {
    const layout = layoutOf([["First", ["a"]]]);
    const { sections } = build({
      ...base,
      layout,
      extra: { unknown: "First", stray: "no-such-workspace" },
      threads: [thread("a"), thread("stray")],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });

  it("lists a workspace that has threads but no open tab", () => {
    const layout = layoutOf([
      ["First", ["a"]],
      ["Second", ["b"]],
    ]);
    const closed = {
      ...layout,
      workspaces: layout.workspaces.map((workspace) =>
        workspace.name === "Second" ? { ...workspace, columns: [] } : workspace,
      ),
    };
    const { sections } = build({
      ...base,
      layout: closed,
      memberships: membershipsOf(layout),
      threads: [thread("a"), thread("b")],
    });
    expect(sections.map((s) => [s.name, ids(s.threads), s.empty])).toEqual([
      ["First", ["a"], false],
      ["Second", ["b"], true],
    ]);
  });

  it("ignores a draft chat and surface tabs when placing threads", () => {
    let layout = layoutOf([["Only", ["a"]]]);
    layout = openLayoutTab(layout, {
      kind: "surface",
      threadRef: scopeThreadRef(environmentId, ThreadId.make("b")),
      surfaceId: "diff",
    });
    const { sections } = build({
      ...base,
      layout,
      threads: [thread("a"), thread("b")],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
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
    const { sections } = build({
      ...base,
      layout: layoutOf([["W", ["a"]]]),
      threads: [thread("a"), ...hidden],
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });

  it("leaves out threads of projects outside the filter", () => {
    const { sections } = build({
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
    const result = build({
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
    const resolved = build({
      ...base,
      layout,
      threads: [thread("a")],
      resolveWorkspaceTitle: () => "Lead tab",
    });
    expect(resolved.sections[0]!.name).toBe("Lead tab");
    const placed = build({ ...base, layout, threads: [thread("a")] });
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
    expect(ids(build({ ...base, layout, threads }).sections[0]!.threads)).toEqual([
      "pinned",
      "old",
      "new",
    ]);
    expect(
      ids(build({ ...base, threadSort: "updated_at", layout, threads }).sections[0]!.threads),
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
      const { sections } = build({
        ...base,
        layout,
        threads,
        query: "login",
      });
      expect(sections.map((s) => [s.name, ids(s.threads)])).toEqual([["Alpha", ["a"]]]);
    });

    it("shows every thread of a workspace whose name matches", () => {
      const { sections } = build({
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
      const result = build({
        ...base,
        layout: hidden,
        threads,
        query: "login",
      });
      expect(result.sections).toEqual([]);
    });
  });

  it("lifts the threads Needs you lists out of their workspace and counts them", () => {
    const { sections } = build({
      ...base,
      layout: layoutOf([["W", ["a", "b"]]]),
      threads: [thread("a"), thread("b")],
      excludedThreadIds: new Set(["a"]),
    });
    expect(ids(sections[0]!.threads)).toEqual(["b"]);
    expect(ids(sections[0]!.needsYouThreads)).toEqual(["a"]);
  });

  it("keeps those threads in their workspace while searching", () => {
    const { sections } = build({
      ...base,
      query: "a",
      layout: layoutOf([["W", ["a"]]]),
      threads: [thread("a")],
      excludedThreadIds: new Set(["a"]),
    });
    expect(ids(sections[0]!.threads)).toEqual(["a"]);
  });
});
