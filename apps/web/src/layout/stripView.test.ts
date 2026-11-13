import { describe, expect, it } from "vite-plus/test";

import { buildLayout } from "./layoutFixtures";
import { selectLayoutPaneSlots } from "./layoutModel";
import { paneToFollow, tabIdsOnScreen } from "./stripView";

const WORKSPACE = buildLayout([[[["a"]], [["b", "b2"], ["c"]], [["d"]]]]).workspaces[0]!;
/** Three columns a third of the strip each. */
const { slots } = selectLayoutPaneSlots(WORKSPACE, { width: 900, whenNoRoom: "always-shrink" });

describe("tabIdsOnScreen", () => {
  it("lists the active tab of every pane at least half inside the view", () => {
    expect(tabIdsOnScreen(slots, 0, 1)).toEqual(new Set(["a", "b", "c", "d"]));
    expect(tabIdsOnScreen(slots, 0, 0.5)).toEqual(new Set(["a", "b", "c"]));
  });

  it("leaves out a column that only peeks at the edge", () => {
    // Column two shows a quarter of its width.
    expect(tabIdsOnScreen(slots, 0, 1 / 3 + 1 / 12)).toEqual(new Set(["a"]));
  });
});

describe("paneToFollow", () => {
  const columns = WORKSPACE.columns;
  const none = new Map<string, string>();

  it("keeps focus while the focused pane is at least half in view", () => {
    expect(paneToFollow(columns, "w0c0p0", slots, 0, 0.5, none)).toBeNull();
  });

  it("moves focus to the column most in view once the focused pane scrolls out", () => {
    expect(paneToFollow(columns, "w0c0p0", slots, 2 / 3, 1, none)).toBe("w0c2p0");
  });

  it("lands on the pane the column last focused, else the pane at the same height", () => {
    expect(
      paneToFollow(columns, "w0c0p0", slots, 1 / 3, 2 / 3, new Map([["w0c1", "w0c1p1"]])),
    ).toBe("w0c1p1");
    expect(paneToFollow(columns, "w0c0p0", slots, 1 / 3, 2 / 3, none)).toBe("w0c1p0");
  });

  it("does nothing without a focused pane or a column in view", () => {
    expect(paneToFollow(columns, null, slots, 0, 1, none)).toBeNull();
    expect(paneToFollow(columns, "w0c0p0", slots, 5, 6, none)).toBeNull();
  });
});
