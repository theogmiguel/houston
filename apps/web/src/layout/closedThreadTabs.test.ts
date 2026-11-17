import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createClosedThreadTabWatcher } from "./closedThreadTabs";
import { createLayoutState, type LayoutTabContent } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";

const environmentId = EnvironmentId.make("local");
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));
const chat = (id: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: ref(id) },
});
const surface = (id: string): LayoutTabContent => ({
  kind: "surface",
  threadRef: ref(id),
  surfaceId: "diff",
});
const shell = (id: string, closed: boolean) => ({
  environmentId,
  id: ThreadId.make(id),
  settledOverride: closed ? ("settled" as const) : null,
});

function setup(contents: ReadonlyArray<LayoutTabContent>) {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: createLayoutState() });
  for (const content of contents) {
    useLayoutStore.getState().openTab(content, { placement: "active-pane", position: "end" });
  }
  return {
    tabs: () =>
      useLayoutStore
        .getState()
        .layout.workspaces.flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs.map((tab) => tab.content)),
    [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }),
  };
}

describe("createClosedThreadTabWatcher", () => {
  it("closes a thread's tab when the thread becomes closed, as a merge does", () => {
    using layout = setup([chat("merged"), chat("other")]);
    const watch = createClosedThreadTabWatcher();
    watch([shell("merged", false), shell("other", false)]);

    watch([shell("merged", true), shell("other", false)]);

    expect(layout.tabs()).toEqual([chat("other")]);
  });

  it("leaves no launcher that offers the closed thread when its tab was the last", () => {
    using layout = setup([chat("merged")]);
    const watch = createClosedThreadTabWatcher();
    watch([shell("merged", false)]);

    watch([shell("merged", true)]);

    const remaining = layout.tabs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: "launcher", context: null });
  });

  it("keeps the tab of a thread opened while already closed, such as from the Closed shelf", () => {
    using layout = setup([chat("old")]);
    const watch = createClosedThreadTabWatcher();

    watch([shell("old", true)]);
    watch([shell("old", true)]);

    expect(layout.tabs()).toEqual([chat("old")]);
  });

  it("closes the tab again when a reopened thread is closed a second time", () => {
    using layout = setup([chat("a"), chat("b")]);
    const watch = createClosedThreadTabWatcher();
    watch([shell("a", true), shell("b", false)]);

    watch([shell("a", false), shell("b", false)]);
    expect(layout.tabs()).toEqual([chat("a"), chat("b")]);

    watch([shell("a", true), shell("b", false)]);
    expect(layout.tabs()).toEqual([chat("b")]);
  });

  it("leaves the thread's surface tabs, which end through their own close", () => {
    using layout = setup([chat("merged"), surface("merged")]);
    const watch = createClosedThreadTabWatcher();
    watch([shell("merged", false)]);

    watch([shell("merged", true)]);

    expect(layout.tabs()).toEqual([surface("merged")]);
  });
});
