import { describe, expect, it } from "vite-plus/test";

import {
  boundOverviewTransform,
  overviewExitScrollLeft,
  overviewSlotStyle,
  overviewZoomedIn,
  overviewZoomedOut,
  overviewRowShift,
  selectOverviewStage,
  selectOverviewStartPaneIds,
} from "./overviewStage";
import {
  focusLayoutWorkspaceStep,
  type LayoutState,
  type LayoutTabContent,
  type LayoutWorkspace,
} from "./layoutModel";

const viewport = { width: 1000, whenNoRoom: "shrink-then-scroll" } as const;
const settings: LayoutTabContent = { kind: "settings" };

function workspace(id: string, withPane: boolean): LayoutWorkspace {
  return {
    id,
    name: null,
    focusedPaneId: withPane ? `pane-${id}` : null,
    cameraWidth: null,
    columns: withPane
      ? [
          {
            id: `column-${id}`,
            width: 1,
            panes: [
              {
                id: `pane-${id}`,
                size: 1,
                activeTabId: `tab-${id}`,
                tabs: [{ id: `tab-${id}`, content: settings }],
              },
            ],
          },
        ]
      : [],
  };
}

function stack(focusedWorkspaceId: string): LayoutState {
  return {
    workspaces: [workspace("a", true), workspace("b", true), workspace("trailing", false)],
    focusedWorkspaceId,
  };
}

const stageOf = (layout: LayoutState) => selectOverviewStage(layout, viewport, viewport.width);

describe("overviewRowShift", () => {
  it("counts the rows the stack moved when a new workspace opens above it, and back", () => {
    const onFirst = stack("a");
    const onNewAbove = focusLayoutWorkspaceStep(onFirst, -1);
    const backOnFirst = focusLayoutWorkspaceStep(onNewAbove, 1);
    expect(stageOf(onNewAbove).focusedRow.workspace.columns).toEqual([]);
    expect(overviewRowShift(stageOf(onFirst).rows, stageOf(onNewAbove).rows)).toBe(1);
    expect(overviewRowShift(stageOf(onNewAbove).rows, stageOf(backOnFirst).rows)).toBe(-1);
  });

  it("leaves the stack in place when the empty workspace below it shows or hides", () => {
    const onLast = stack("b");
    const onNewBelow = focusLayoutWorkspaceStep(onLast, 1);
    expect(stageOf(onNewBelow).focusedRow.workspace.id).toBe("trailing");
    expect(overviewRowShift(stageOf(onLast).rows, stageOf(onNewBelow).rows)).toBe(0);
    expect(overviewRowShift(stageOf(onNewBelow).rows, stageOf(onLast).rows)).toBe(0);
  });
});

const box = { left: 100, top: 50, width: 1000, height: 600 };
const windowSize = { width: 1280, height: 800 };

describe("selectOverviewStage", () => {
  it("lists every workspace with something in it, plus the empty one only while focused", () => {
    expect(stageOf(stack("a")).rows.map((row) => row.workspace.id)).toEqual(["a", "b"]);
    expect(stageOf(stack("trailing")).rows.map((row) => row.workspace.id)).toEqual([
      "a",
      "b",
      "trailing",
    ]);
  });

  it("scales rows from the window's width, not the strip's", () => {
    const narrowStrip = { ...viewport, width: 500 };
    const stage = selectOverviewStage(stack("a"), narrowStrip, 1000);
    expect(stage.scale).toBeCloseTo(0.3625 * 2);
    expect(stage.gap * stage.scale).toBeCloseTo(24);
  });
});

describe("stage transforms", () => {
  it("zooms in on a row by moving its top-left to the strip's", () => {
    const stage = stageOf(stack("b"));
    const row = stage.rows[1]!;
    const transform = overviewZoomedIn(stage, row, 0, box);
    expect(transform.scale).toBe(1);
    expect(transform.y).toBe(-(box.height + stage.gap));
    expect(transform.x).toBeCloseTo(-((1 - row.stripWidth) / 2) * box.width);
  });

  it("centers the focused row in the window when zoomed out", () => {
    const stage = stageOf(stack("a"));
    const transform = overviewZoomedOut(stage, box, windowSize);
    expect(transform.scale).toBe(stage.scale);
    const centerX = transform.x + box.left + transform.scale * (box.width / 2);
    const centerY = transform.y + box.top + transform.scale * (box.height / 2);
    expect(centerX).toBeCloseTo(windowSize.width / 2);
    expect(centerY).toBeCloseTo(windowSize.height / 2);
  });

  it("keeps the stage within reach of its first and last rows", () => {
    const stage = stageOf(stack("a"));
    const far = { x: 1e6, y: -1e6, scale: stage.scale };
    const bounded = boundOverviewTransform(stage, box, far, 0, windowSize);
    expect(Math.abs(bounded.x)).toBeLessThan(windowSize.width * 2);
    expect(Math.abs(bounded.y)).toBeLessThan(windowSize.height * 4);
  });
});

describe("exit scroll", () => {
  it("starts at the left for a workspace the strip did not show", () => {
    const row = stageOf(stack("a")).rows[0]!;
    const entry = { scrollLeft: 400, workspaceId: "other", rowOffset: 0 };
    expect(overviewExitScrollLeft(row, 1000, entry)).toBe(0);
  });

  it("never scrolls past a strip that fits the window", () => {
    const row = stageOf(stack("a")).rows[0]!;
    const entry = { scrollLeft: 400, workspaceId: "a", rowOffset: 0 };
    expect(overviewExitScrollLeft(row, 1000, entry)).toBe(0);
  });

  it("names the first pane of every row as where the window starts when nothing scrolled", () => {
    const stage = stageOf(stack("a"));
    const entry = { scrollLeft: 0, workspaceId: "a", rowOffset: 0 };
    expect([...selectOverviewStartPaneIds(stage, 1000, entry)].toSorted()).toEqual([
      "pane-a",
      "pane-b",
    ]);
  });
});

describe("overviewSlotStyle", () => {
  it("insets a pane by the edge only on the sides that have a neighbor", () => {
    const row = stageOf(stack("a")).rows[0]!;
    const slot = { ...row.slots[0]!, hasLeft: true, hasRight: false, hasAbove: false, hasBelow: false };
    const style = overviewSlotStyle(row, slot, 10, "4px");
    expect(style.left).toContain("+ 4px");
    expect(style.width).toContain("- 4px - 0px");
    expect(style.top).toContain("+ 0px");
  });
});
