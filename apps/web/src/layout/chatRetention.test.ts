import { describe, expect, it } from "vite-plus/test";

import {
  keptTabIds,
  nearTabIdsInOverview,
  nearTabIdsOnStrip,
  nextRecentTabIds,
  nextRetainedTabIds,
  RENDERED_RECENT_CHATS,
} from "./chatRetention";
import { buildLayout } from "./layoutFixtures";
import { selectLayoutPaneSlots } from "./layoutModel";

const WINDOW = 1000;
/** Ten columns of 500px: a strip of 5000px in a window of 1000px. */
const WORKSPACE = buildLayout([[..."abcdefghij"].map((name) => [[name]])]).workspaces[0]!;
WORKSPACE.cameraWidth = 1000;
for (const column of WORKSPACE.columns) column.width = 0.5;
const strip = selectLayoutPaneSlots(WORKSPACE, { width: WINDOW, whenNoRoom: "shrink-then-scroll" });
const stripPx = strip.stripWidth * WINDOW;

describe("nearTabIdsOnStrip", () => {
  it("includes the panes within a window of the camera, and none further", () => {
    const near = nearTabIdsOnStrip([{ slots: strip.slots, rowPx: stripPx, camera: 0 }], WINDOW);
    // On screen a and b; one window past the edge c and d; e starts at 2000, exactly past 2 windows.
    expect([...near].toSorted()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("follows the camera in both directions", () => {
    const near = nearTabIdsOnStrip([{ slots: strip.slots, rowPx: stripPx, camera: 2500 }], WINDOW);
    // Camera 2500: panes ending before 1500 are out, so a and b go and c (ending at 1500) stays.
    expect([...near].toSorted()).toEqual(["c", "d", "e", "f", "g", "h", "i", "j"]);
  });

  it("skips a pane with no active tab", () => {
    const slots = strip.slots.map((slot) => ({ ...slot, activeTabId: null }));
    expect(nearTabIdsOnStrip([{ slots, rowPx: stripPx, camera: 0 }], WINDOW).size).toBe(0);
  });
});

describe("nearTabIdsInOverview", () => {
  const rows = [{ slots: strip.slots, stripWidth: strip.stripWidth }];

  it("includes the panes drawn wide enough to read", () => {
    // 500px at 0.3 is 150px, over the 120px a pane needs.
    expect(nearTabIdsInOverview(rows, WINDOW, 0.3).size).toBe(10);
  });

  it("leaves out the panes drawn too small to read", () => {
    expect(nearTabIdsInOverview(rows, WINDOW, 0.2).size).toBe(0);
  });
});

describe("nextRecentTabIds", () => {
  const exists = (id: string) => id !== "gone";

  it("puts the near tabs first and keeps earlier ones behind them", () => {
    expect(nextRecentTabIds(new Set(["c", "d"]), ["a", "c", "b"], exists)).toEqual([
      "c",
      "d",
      "a",
      "b",
    ]);
  });

  it("drops a tab that no longer exists", () => {
    expect(nextRecentTabIds(new Set(["a"]), ["gone", "b"], exists)).toEqual(["a", "b"]);
  });
});

describe("keptTabIds", () => {
  it("keeps the near, focused and related tabs and the most recent ones that left", () => {
    const recent = ["n1", "n2", ...Array.from({ length: 12 }, (_, i) => `r${i}`)];
    const kept = keptTabIds(new Set(["n1", "n2"]), recent, "focus", "related");
    expect(kept.has("n1") && kept.has("focus") && kept.has("related")).toBe(true);
    const recents = recent.filter((id) => id.startsWith("r") && kept.has(id));
    expect(recents).toHaveLength(RENDERED_RECENT_CHATS);
    expect(recents).toEqual(
      recent.filter((id) => id.startsWith("r")).slice(0, RENDERED_RECENT_CHATS),
    );
  });

  it("counts only tabs outside the near set against the cap", () => {
    const kept = keptTabIds(new Set(["a"]), ["a", "b"], null, null);
    expect([...kept].toSorted()).toEqual(["a", "b"]);
  });
});

describe("nextRetainedTabIds", () => {
  const exists = (id: string) => id !== "gone";

  it("keeps a tab that was visible and is hidden now, behind the visible ones", () => {
    expect(nextRetainedTabIds(["b"], ["a", "b"], exists)).toEqual(["b", "a"]);
  });

  it("lets go of a tab that no longer exists", () => {
    expect(nextRetainedTabIds(["a"], ["gone", "a"], exists)).toEqual(["a"]);
  });
});
