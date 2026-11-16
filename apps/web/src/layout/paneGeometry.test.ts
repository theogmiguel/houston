import { describe, expect, it } from "vite-plus/test";

import { buildLayout } from "./layoutFixtures";
import { selectFocusedWorkspace } from "./layoutModel";
import { selectShownSlots, slotStyle, stackSlotStyle } from "./paneGeometry";

const viewport = { width: 1000, whenNoRoom: "shrink-then-scroll" } as const;

describe("slotStyle", () => {
  const slot = (overrides: Partial<Parameters<typeof slotStyle>[0]>) => ({
    paneId: "p",
    activeTabId: "a",
    rect: { left: 0, top: 0, width: 0.5, height: 1 },
    hasLeft: false,
    hasRight: false,
    hasAbove: false,
    hasBelow: false,
    ...overrides,
  });

  it("leaves no gap at the strip's own edges", () => {
    expect(slotStyle(slot({}))).toEqual({
      left: "round(calc(0% + 0px), 1px)",
      top: "round(calc(0% + 0px), 1px)",
      width: "calc(round(calc(50% + -1 * 0px), 1px) - round(calc(0% + 0px), 1px))",
      height: "calc(round(calc(100% + -1 * 0px), 1px) - round(calc(0% + 0px), 1px))",
    });
  });

  it("insets each side that has a neighbor by half the gutter so two panes leave one gutter", () => {
    const style = slotStyle(slot({ hasLeft: true, hasBelow: true }));
    expect(style.left).toBe("round(calc(0% + 4px), 1px)");
    expect(style.height).toContain("-1 * 4px");
  });

  it("measures across a long strip in pixels", () => {
    const style = slotStyle(slot({ rect: { left: 0.5, top: 0, width: 0.5, height: 1 } }), 2000);
    expect(style.left).toBe("round(calc(1000px + 0px), 1px)");
  });
});

describe("stackSlotStyle", () => {
  it("places a row's pane below the rows above it and shifts it by the row's camera", () => {
    const style = stackSlotStyle(
      { id: "w1", workspace: null, offset: 1, slots: [], stripWidth: 2, camera: 300 },
      {
        paneId: "p",
        activeTabId: "a",
        rect: { left: 0.5, top: 0, width: 0.5, height: 1 },
        hasLeft: false,
        hasRight: false,
        hasAbove: false,
        hasBelow: false,
      },
      16,
    );
    expect(style.left).toBe("round(calc(100% - 300px + 0px), 1px)");
    expect(style.top).toBe("round(calc(100% + 16px + 0px), 1px)");
  });
});

describe("selectShownSlots", () => {
  const layout = buildLayout([[[["a"]], [["b"], ["c"]]]]);
  const workspace = selectFocusedWorkspace(layout);

  it("shows every pane on a wide window", () => {
    const shown = selectShownSlots(workspace, viewport, false, null);
    expect(shown.slots.map((slot) => slot.paneId)).toEqual(["w0c0p0", "w0c1p0", "w0c1p1"]);
    expect(shown.paneCount).toBe(3);
  });

  it("shows only the focused pane, full size, on a narrow window", () => {
    const shown = selectShownSlots(workspace, viewport, true, null);
    expect(shown.slots).toHaveLength(1);
    expect(shown.slots[0]).toMatchObject({
      paneId: "w0c0p0",
      rect: { left: 0, top: 0, width: 1, height: 1 },
      hasLeft: false,
      hasRight: false,
    });
    expect(shown.paneCount).toBe(1);
  });

  it("shows the maximized pane alone and keeps the pane count", () => {
    const shown = selectShownSlots(workspace, viewport, false, "b");
    expect(shown.slots.map((slot) => slot.paneId)).toEqual(["w0c1p0"]);
    expect(shown.paneCount).toBe(3);
  });

  it("leaves a lone pane as it is", () => {
    const lone = selectFocusedWorkspace(buildLayout([[[["a", "b"]]]]));
    expect(selectShownSlots(lone, viewport, true, null).slots).toHaveLength(1);
  });
});
