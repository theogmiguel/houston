import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildLayout } from "../layout/layoutFixtures";
import { selectFocusedTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { openThreadInLayout } from "./openThreadInLayout";

const ENVIRONMENT_ID = EnvironmentId.make("local");
const ref = (id: string) => scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(id));
const pathnameOf = (id: string) => `/${ENVIRONMENT_ID}/${id}`;

function setup(shape: readonly (readonly (readonly (readonly string[])[])[])[]) {
  const original = useLayoutStore.getState().layout;
  useLayoutStore.setState({ layout: buildLayout(shape) });
  return {
    tabs: () =>
      useLayoutStore
        .getState()
        .layout.workspaces.flatMap((workspace) => workspace.columns)
        .flatMap((column) => column.panes)
        .flatMap((pane) => pane.tabs),
    focused: () => selectFocusedTab(useLayoutStore.getState().layout),
    [Symbol.dispose]: () => useLayoutStore.setState({ layout: original }),
  };
}

/** A router stand-in whose pathname follows the navigations it receives. */
function navigation(start: string) {
  const state = { pathname: start };
  return {
    state,
    navigation: {
      navigate: vi.fn(
        async (options: { readonly params: { environmentId: string; threadId: string } }) => {
          state.pathname = `/${options.params.environmentId}/${options.params.threadId}`;
        },
      ),
      pathname: () => state.pathname,
    },
  };
}

describe("openThreadInLayout", () => {
  it("shows a sub-agent in the tab it was opened from and keeps that tab's identity", async () => {
    using layout = setup([[[["parent"]]]]);
    const { state, navigation: router } = navigation(pathnameOf("parent"));
    const tabId = layout.focused()!.id;

    await openThreadInLayout(router, ref("child"), { from: ref("parent") });

    expect(layout.tabs()).toHaveLength(1);
    expect(layout.focused()!.id).toBe(tabId);
    expect(layout.focused()!.content).toMatchObject({
      kind: "chat",
      target: { kind: "server", threadRef: { threadId: "child" } },
    });
    expect(state.pathname).toBe(pathnameOf("child"));
  });

  it("returns from a sub-agent to its parent in the same tab", async () => {
    using layout = setup([[[["child"]]]]);
    const { state, navigation: router } = navigation(pathnameOf("child"));
    const tabId = layout.focused()!.id;

    await openThreadInLayout(router, ref("parent"), { from: ref("child") });

    expect(layout.tabs()).toHaveLength(1);
    expect(layout.focused()!.id).toBe(tabId);
    expect(layout.focused()!.content).toMatchObject({
      kind: "chat",
      target: { kind: "server", threadRef: { threadId: "parent" } },
    });
    expect(state.pathname).toBe(pathnameOf("parent"));
  });

  it("takes over a tab already showing the opened thread instead of leaving a duplicate", async () => {
    using layout = setup([[[["parent", "child"]]]]);
    const { navigation: router } = navigation(pathnameOf("parent"));
    const parentTabId = layout.focused()!.id;

    await openThreadInLayout(router, ref("child"), { from: ref("parent") });

    expect(layout.tabs()).toHaveLength(1);
    expect(layout.focused()!.id).toBe(parentTabId);
    expect(layout.focused()!.content).toMatchObject({
      kind: "chat",
      target: { kind: "server", threadRef: { threadId: "child" } },
    });
  });

  it("leaves an explicit join to open a tab of its own", async () => {
    using layout = setup([[[["parent"]]]]);
    const { navigation: router } = navigation(pathnameOf("parent"));

    await openThreadInLayout(router, ref("child"), { intent: "join", from: ref("parent") });

    expect(layout.tabs()).toHaveLength(1);
    expect(layout.focused()!.content).toMatchObject({
      kind: "chat",
      target: { kind: "server", threadRef: { threadId: "parent" } },
    });
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: "child" },
    });
  });
});
