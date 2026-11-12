import { LAYOUT_KEYBINDING_COMMANDS } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { buildLayout } from "../layout/layoutFixtures";
import { selectFocusedPane } from "../layout/layoutModel";
import { useLayoutStore } from "../layout/layoutStore";
import { buildLayoutCommandHandlers } from "./layoutCommandHandlers";

/** The handlers touch only the event's two cancel methods. */
function key() {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return event as unknown as KeyboardEvent;
}

afterEach(() => useLayoutStore.getState().reset());

describe("buildLayoutCommandHandlers", () => {
  it("handles every layout command but the overview", () => {
    const handled = Object.keys(buildLayoutCommandHandlers()).toSorted();
    const expected = LAYOUT_KEYBINDING_COMMANDS.filter(
      (command) => command !== "layout.overview",
    ).toSorted();
    expect(handled).toEqual(expected);
  });

  it("moves focus to the next column on layout.focusRight", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]], [["b"]]]]));
    const event = key();
    const result = buildLayoutCommandHandlers()["layout.focusRight"]!(event);
    expect(result).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(selectFocusedPane(useLayoutStore.getState().layout)?.id).toBe("w0c1p0");
  });

  it("opens a launcher tab in a new column on layout.splitRight", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]]]]));
    buildLayoutCommandHandlers()["layout.splitRight"]!(key());
    const workspace = useLayoutStore.getState().layout.workspaces[0]!;
    expect(workspace.columns).toHaveLength(2);
    expect(workspace.columns[1]!.panes[0]!.tabs[0]!.content.kind).toBe("launcher");
  });

  it("swallows a command the open overview does not list", () => {
    useLayoutStore.getState().setLayoutFromServer(buildLayout([[[["a"]], [["b"]]]]));
    useLayoutStore.setState({ overviewOpen: true });
    const before = useLayoutStore.getState().layout;
    const event = key();
    buildLayoutCommandHandlers()["layout.cycleColumnWidth"]!(event);
    expect(useLayoutStore.getState().layout).toBe(before);
    expect(event.defaultPrevented).toBe(true);
    useLayoutStore.setState({ overviewOpen: false });
  });
});
