import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("local");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const subagentRef = scopeThreadRef(environmentId, ThreadId.make("subagent"));

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadLineage: ((ref: typeof subagentRef) =>
    ref.threadId === subagentRef.threadId
      ? { parentThreadId: parentRef.threadId, relationshipToParent: "subagent" }
      : null) as never,
}));

const toastAdd = vi.hoisted(() => vi.fn());
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toastAdd } };
});

import { useClosedViewStore } from "../closedViewStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  closeLayoutTabByUser,
  closeOtherLayoutTabsByUser,
  registerLayoutSurfaceCloser,
} from "./layoutActions";
import {
  createLayoutState,
  findLayoutTab,
  isBlankLayoutWorkspace,
  selectFocusedTab,
  type LayoutTabContent,
} from "./layoutModel";
import {
  runInNewLayoutTab,
  subscribeLayoutThreadsClosedByUser,
  useLayoutStore,
} from "./layoutStore";

const parent: LayoutTabContent = { kind: "chat", target: { kind: "server", threadRef: parentRef } };
const subagent: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: subagentRef },
};
const other: LayoutTabContent = {
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make("other")) },
};

function setup(contents: ReadonlyArray<LayoutTabContent>) {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  for (const content of contents) {
    useLayoutStore.getState().openTab(content, { placement: "active-pane", position: "end" });
  }
  const closed: unknown[] = [];
  const unsubscribe = subscribeLayoutThreadsClosedByUser((targets) => closed.push(...targets));
  return {
    closed,
    tabOf: (content: LayoutTabContent) =>
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.content === content)?.tab,
    chats: () =>
      useLayoutStore
        .getState()
        .layout.workspaces.filter((workspace) => !isBlankLayoutWorkspace(workspace))
        .flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
    [Symbol.dispose]: () => {
      unsubscribe();
      useLayoutStore.setState({ layout: original });
    },
  };
}

describe("closeLayoutTabByUser", () => {
  it("returns a subagent's tab to its parent thread without closing or settling the parent", () => {
    using layout = setup([other, subagent]);
    const subagentTab = layout.tabOf(subagent)!;
    closeLayoutTabByUser(subagentTab.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)).toEqual({
      ...subagentTab,
      content: parent,
    });
    expect(layout.chats()).toEqual([other, parent]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab onto the parent's own tab when the parent is already open", () => {
    using layout = setup([parent, other, subagent]);
    const parentTab = layout.tabOf(parent)!;
    closeLayoutTabByUser(layout.tabOf(subagent)!.id);
    expect(selectFocusedTab(useLayoutStore.getState().layout)?.id).toBe(parentTab.id);
    expect(layout.chats()).toEqual([parent, other]);
    expect(layout.closed).toEqual([]);
  });

  it("closes a subagent's tab outright when closing the others", () => {
    using layout = setup([other, subagent]);
    closeOtherLayoutTabsByUser(layout.tabOf(other)!.id);
    expect(layout.chats()).toEqual([other]);
  });

  it.each([{ contents: [subagent, other] }, { contents: [parent, subagent, other] }])(
    "closes a background subagent tab without opening or focusing its parent: $contents",
    ({ contents }) => {
      using layout = setup(contents);
      const focused = selectFocusedTab(useLayoutStore.getState().layout);
      closeLayoutTabByUser(layout.tabOf(subagent)!.id);
      expect(selectFocusedTab(useLayoutStore.getState().layout)).toBe(focused);
      expect(layout.chats()).toEqual(contents.filter((content) => content !== subagent));
    },
  );
});

describe("runInNewLayoutTab", () => {
  it("keeps a later new tab request when an earlier one settles", async () => {
    vi.useFakeTimers();
    try {
      let finishFirst = () => {};
      const first = runInNewLayoutTab(
        () => new Promise<void>((resolve) => (finishFirst = resolve)),
      );
      // The first route rendered and took its request.
      useLayoutStore.getState().clearNewTabRequest();
      void runInNewLayoutTab(() => new Promise<void>(() => {}));
      finishFirst();
      await first;
      vi.runAllTimers();
      expect(useLayoutStore.getState().newTabRequest).not.toBeNull();
    } finally {
      vi.useRealTimers();
      useLayoutStore.getState().clearNewTabRequest();
    }
  });
});

describe("closeLayoutTabByUser: surfaces", () => {
  const surface: LayoutTabContent = {
    kind: "surface",
    threadRef: scopeThreadRef(environmentId, ThreadId.make("owner")),
    surfaceId: "diff",
  };

  it("hands a surface tab to the registered closer, which closes its tab itself", () => {
    using layout = setup([other, surface]);
    const calls: unknown[] = [];
    const unregister = registerLayoutSurfaceCloser((threadRef, surfaceId, options) => {
      calls.push({ threadRef, surfaceId, options });
    });
    try {
      closeLayoutTabByUser(layout.tabOf(surface)!.id, { bulk: true });
    } finally {
      unregister();
    }
    expect(calls).toEqual([
      { threadRef: surface.threadRef, surfaceId: "diff", options: { bulk: true } },
    ]);
    expect(layout.chats()).toEqual([other, surface]);
  });

  it("closes a surface tab directly while no closer is registered", () => {
    using layout = setup([other, surface]);
    closeLayoutTabByUser(layout.tabOf(surface)!.id);
    expect(layout.chats()).toEqual([other]);
  });
});

describe("closeLayoutTabByUser: reopening", () => {
  it("remembers a closed chat with its pane and position for the reopen shortcut", () => {
    using layout = setup([other, parent]);
    useClosedViewStore.setState({ entries: [] });
    const tab = layout.tabOf(parent)!;
    const location = findLayoutTab(
      useLayoutStore.getState().layout,
      (candidate) => candidate.id === tab.id,
    )!;
    closeLayoutTabByUser(tab.id);
    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "chat", threadRef: parentRef, paneId: location.pane.id, index: location.tabIndex },
    ]);
    useClosedViewStore.setState({ entries: [] });
  });
});

describe("closeLayoutTabByUser: drafts", () => {
  const draftId = DraftId.make("draft-1");
  const draftRef = scopeThreadRef(environmentId, ThreadId.make("draft-thread"));
  const draftContent: LayoutTabContent = {
    kind: "chat",
    target: { kind: "draft", draftId },
  };
  const seedDraft = (prompt: string) => {
    useComposerDraftStore.setState({
      draftsByThreadKey: prompt.length === 0 ? {} : { [draftId]: { prompt } as never },
      draftThreadsByThreadKey: {
        [draftId]: {
          environmentId,
          projectId: "project-1",
          threadId: draftRef.threadId,
          logicalProjectKey: "local:project-1",
          createdAt: "2026-11-19T00:00:00.000Z",
          runtimeMode: "default",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          envMode: "local",
          startFromOrigin: false,
        } as never,
      },
    });
  };
  const clearDrafts = () =>
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });

  it("remembers a closed draft's id, keeps its text and offers to reopen it", () => {
    using _drafts = { [Symbol.dispose]: clearDrafts };
    using layout = setup([draftContent]);
    seedDraft("hello");
    toastAdd.mockClear();
    const tab = layout.tabOf(draftContent)!;

    closeLayoutTabByUser(tab.id);

    expect(useClosedViewStore.getState().entries).toMatchObject([
      { kind: "chat", draftId, threadRef: draftRef },
    ]);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("hello");
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Draft closed",
        actionProps: expect.objectContaining({ children: "Reopen" }),
      }),
    );
    useClosedViewStore.setState({ entries: [] });
  });

  it("closes an empty draft silently", () => {
    using _drafts = { [Symbol.dispose]: clearDrafts };
    using layout = setup([draftContent]);
    seedDraft("");
    toastAdd.mockClear();

    closeLayoutTabByUser(layout.tabOf(draftContent)!.id);

    expect(toastAdd).not.toHaveBeenCalled();
    expect(useClosedViewStore.getState().entries).toMatchObject([{ draftId }]);
    useClosedViewStore.setState({ entries: [] });
  });

  it("recovers a draft's id from the thread ref when the tab carries only that", () => {
    using _drafts = { [Symbol.dispose]: clearDrafts };
    const serverDraft: LayoutTabContent = {
      kind: "chat",
      target: { kind: "server", threadRef: draftRef },
    };
    using layout = setup([serverDraft]);
    seedDraft("hello");
    toastAdd.mockClear();

    closeLayoutTabByUser(layout.tabOf(serverDraft)!.id);

    expect(useClosedViewStore.getState().entries).toMatchObject([{ draftId, threadRef: draftRef }]);
    expect(toastAdd).toHaveBeenCalledOnce();
    useClosedViewStore.setState({ entries: [] });
  });
});
