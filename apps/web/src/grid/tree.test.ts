import { describe, expect, it } from "vite-plus/test";

import {
  type LayoutNode,
  type SplitNode,
  appendThread,
  clampSplitRatio,
  computeRects,
  evenGrid,
  findThread,
  gridPreset,
  isGridPreset,
  MIN_PANE_PX,
  moveThread,
  preorderLeaves,
  prune,
  quadrant,
  reconcileThreads,
  removeThread,
  setRatio,
  swapThread,
  threadLeaf,
  tidy,
} from "./tree";

const leaf = (threadId: string) => threadLeaf(threadId, `p-${threadId}`);

function row(...children: LayoutNode[]): SplitNode {
  return {
    kind: "split",
    dir: "row",
    children,
    weights: children.map(() => 100 / children.length),
  };
}

describe("prune", () => {
  it("drops dead threads and collapses a single-child split", () => {
    const tree = row(leaf("a"), leaf("b"), leaf("c"));
    expect(preorderLeaves(prune(tree, new Set(["b"]))!)).toEqual(["b"]);
    expect(prune(row(leaf("a"), leaf("b")), new Set(["b"]))).toEqual(leaf("b"));
  });
});

describe("appendThread", () => {
  it("lands at the root, preserves dragged ratios and gives the newcomer 1/n", () => {
    const custom: SplitNode = { ...row(leaf("a"), leaf("b")), weights: [70, 30] };
    const next = appendThread(custom, "c") as SplitNode;
    expect(next.children).toHaveLength(3);
    expect(next.weights[2]).toBeCloseTo(100 / 3);
    expect(next.weights[0]! / next.weights[1]!).toBeCloseTo(70 / 30);
    expect(preorderLeaves(next)).toEqual(["a", "b", "c"]);
  });

  it("starts the tree when the grid is empty", () => {
    expect(appendThread(null, "a")).toMatchObject({ kind: "thread", threadId: "a" });
  });
});

describe("removeThread", () => {
  it("removes one cell without collapsing its namesake thread", () => {
    const tree = row(leaf("a"), leaf("b"), leaf("c"));
    expect(preorderLeaves(removeThread(tree, "b")!)).toEqual(["a", "c"]);
    expect(removeThread(leaf("a"), "a")).toBeNull();
  });
});

describe("setRatio", () => {
  it("redistributes between the two neighbours only", () => {
    const tree = row(leaf("a"), leaf("b"), leaf("c"));
    const next = setRatio(tree, [], 0, 0.25) as SplitNode;
    const pairSum = 200 / 3;
    expect(next.weights[0]).toBeCloseTo(0.25 * pairSum);
    expect(next.weights[1]).toBeCloseTo(0.75 * pairSum);
    expect(next.weights[2]).toBeCloseTo(100 / 3);
  });

  it("ignores stale indices instead of injecting NaN", () => {
    const tree = row(leaf("a"), leaf("b"));
    expect((setRatio(tree, [], 1, 0.5) as SplitNode).weights).toEqual([50, 50]);
    expect(setRatio(tree, [7], 0, 0.5)).toEqual(tree);
  });
});

describe("moveThread / swapThread", () => {
  it("is a no-op when the dragged thread is no longer in the grid", () => {
    const tree = row(leaf("a"), leaf("b"));
    expect(moveThread(tree, "gone", "b", "right")).toEqual(tree);
  });

  it("moves a thread beside another one", () => {
    const tree = row(leaf("a"), leaf("b"), leaf("c"));
    const next = moveThread(tree, "c", "a", "left");
    expect(preorderLeaves(next)).toEqual(["c", "a", "b"]);
  });

  it("swapThread exchanges cells and keeps their weights", () => {
    const tree: SplitNode = { ...row(leaf("a"), leaf("b")), weights: [70, 30] };
    const next = swapThread(tree, "a", "b") as SplitNode;
    expect(preorderLeaves(next)).toEqual(["b", "a"]);
    expect(next.weights).toEqual([70, 30]);
  });
});

describe("reconcileThreads", () => {
  it("builds an even grid when there is no tree", () => {
    const tree = reconcileThreads(null, ["a", "b", "c", "d"])!;
    const { leaves } = computeRects(tree);
    expect(leaves).toHaveLength(4);
    for (const { rect } of leaves) {
      expect(rect.w).toBeCloseTo(50);
      expect(rect.h).toBeCloseTo(50);
    }
  });

  it("prunes removed threads and appends new ones", () => {
    const tree = row(leaf("a"), leaf("b"));
    expect(preorderLeaves(reconcileThreads(tree, ["b", "c"])!)).toEqual(["b", "c"]);
  });
});

describe("computeRects", () => {
  it("places siblings inside their split and leaves a splitter between them", () => {
    const { leaves, splitters } = computeRects(row(leaf("a"), leaf("b")));
    expect(leaves.map((entry) => entry.node.threadId)).toEqual(["a", "b"]);
    expect(leaves[0]!.rect.x).toBeCloseTo(0);
    expect(leaves[1]!.rect.x).toBeCloseTo(50);
    expect(splitters).toHaveLength(1);
    expect(splitters[0]!.dir).toBe("row");
  });
});

describe("gridPreset", () => {
  it("keeps the first thread in the leading, full-height slot for three and five", () => {
    for (const count of [3, 5]) {
      const ids = ["a", "b", "c", "d", "e"].slice(0, count);
      const { leaves } = computeRects(gridPreset(ids)!);
      const first = leaves.find((leaf) => leaf.node.threadId === "a")!;
      for (const leaf of leaves) {
        if (leaf.node.threadId !== "a") {
          expect(leaf.rect.h).toBeLessThan(first.rect.h);
        }
      }
      expect(first.rect.h).toBeCloseTo(100);
    }
  });

  it("lays out one to six threads in reading order", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (let count = 1; count <= 6; count += 1) {
      expect(preorderLeaves(gridPreset(ids.slice(0, count))!)).toEqual(ids.slice(0, count));
    }
  });

  it("uses the preset shapes from the grid board", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    expect(normalizeWeights(gridPreset(ids.slice(0, 3))!)).toEqual([
      [55.56, 44.44],
      [50, 50],
    ]);
    expect(normalizeWeights(gridPreset(ids.slice(0, 5))!)).toEqual([
      [37.5, 62.5],
      [50, 50],
      [50, 50],
      [50, 50],
    ]);
  });

  it("recognizes its own arrangements but not a dragged split", () => {
    const ids = ["a", "b", "c"];
    const preset = gridPreset(ids)!;
    expect(isGridPreset(preset, ids)).toBe(true);
    const dragged = setRatio(preset, [], 0, 0.3);
    expect(isGridPreset(dragged, ids)).toBe(false);
  });
});

function normalizeWeights(tree: LayoutNode): number[][] {
  const rows: number[][] = [];
  const walk = (node: LayoutNode): void => {
    if (node.kind !== "split") return;
    rows.push(node.weights.map((weight) => Number(weight.toFixed(2))));
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return rows;
}

describe("evenGrid / tidy / findThread", () => {
  it("chunks rows by a bounded column count", () => {
    const tree = evenGrid(["a", "b", "c", "d", "e"])!;
    expect(computeRects(tree).leaves).toHaveLength(5);
    expect(preorderLeaves(tree)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("tidy regrids the same threads", () => {
    const tree = tidy(row(leaf("a"), leaf("b"), leaf("c")), "row")!;
    expect(preorderLeaves(tree)).toEqual(["a", "b", "c"]);
  });

  it("finds a thread cell by its thread id", () => {
    expect(findThread(row(leaf("a"), leaf("b")), "b")).toEqual(leaf("b"));
    expect(findThread(row(leaf("a")), "z")).toBeNull();
  });
});

describe("clampSplitRatio", () => {
  it("keeps both cells at or above MIN_PANE_PX", () => {
    expect(clampSplitRatio(-1, 1200)).toBeCloseTo(MIN_PANE_PX / 1200);
    expect(clampSplitRatio(2, 1200)).toBeCloseTo(1 - MIN_PANE_PX / 1200);
    expect(clampSplitRatio(0.5, 1200)).toBeCloseTo(0.5);
  });

  it("pins to 0.5 when the pair cannot give both cells the floor", () => {
    expect(clampSplitRatio(0.9, 2 * MIN_PANE_PX)).toBeCloseTo(0.5);
    expect(clampSplitRatio(0.9, -5)).toBe(0.5);
  });
});

describe("quadrant", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  it("reads the side nearest the pointer", () => {
    expect(quadrant(rect, 10, 50)).toBe("left");
    expect(quadrant(rect, 90, 50)).toBe("right");
    expect(quadrant(rect, 50, 10)).toBe("top");
    expect(quadrant(rect, 50, 90)).toBe("bottom");
    expect(quadrant(rect, 50, 50)).toBe("center");
  });
});
