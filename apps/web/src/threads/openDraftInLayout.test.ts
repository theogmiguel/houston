import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createLayoutState, findLayoutTab, selectFocusedTab } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { openAsNewThreadTab } from "./openDraftInLayout";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-1"));
const chat = { kind: "chat", target: { kind: "server", threadRef } } as const;

beforeEach(() => {
  vi.useFakeTimers();
  useLayoutStore.setState({
    layout: createLayoutState(),
    layoutLoaded: true,
    newTabRequest: null,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  useLayoutStore.setState({ newTabRequest: null });
});

describe("openAsNewThreadTab", () => {
  it("opens a new thread in a new tab beside the chat on screen", async () => {
    const store = useLayoutStore.getState();
    store.openTab(chat, { placement: "active-pane", position: "end" });
    const openChat = selectFocusedTab(useLayoutStore.getState().layout)!;

    await openAsNewThreadTab(async () => undefined);

    expect(useLayoutStore.getState().newTabRequest?.request).toBe("active-pane");
    expect(
      findLayoutTab(useLayoutStore.getState().layout, (tab) => tab.id === openChat.id),
    ).not.toBeNull();
  });

  it("turns the focused launcher into the new thread", async () => {
    const store = useLayoutStore.getState();
    store.openTab(
      { kind: "launcher", id: "launcher-1", context: null },
      {
        placement: "active-pane",
        position: "end",
      },
    );
    const launcher = selectFocusedTab(useLayoutStore.getState().layout)!;

    await openAsNewThreadTab(async () => undefined);

    expect(useLayoutStore.getState().newTabRequest?.request).toEqual({
      replaceTabId: launcher.id,
    });
  });
});
