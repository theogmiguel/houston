import { describe, expect, it } from "vite-plus/test";

import { blockOrder, mergeBlocks } from "./ab.ts";
import type { ScaleResult } from "./run.ts";

const part = (samples: ReadonlyArray<number>, extra: Partial<ScaleResult> = {}): ScaleResult => ({
  scale: 10,
  size: 1_000,
  samples,
  summary: null,
  statements: [],
  ...extra,
});

describe("db-load A/B blocks", () => {
  it("alternates which side goes first", () => {
    expect([0, 1, 2, 3].map((block) => blockOrder("a", "b", block))).toEqual([
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
      ["b", "a"],
    ]);
  });

  it("merges every block's samples and keeps the last block's plans and any error", () => {
    const merged = mergeBlocks([
      { q: part([1, 2]), only: part([5]) },
      {
        q: part([3], { statements: [{ sql: "SELECT 1", executions: 1, plan: [], fullScans: [] }] }),
      },
      { q: part([4], { error: "boom" }) },
    ]);
    expect(merged.q!.samples).toEqual([1, 2, 3, 4]);
    expect(merged.q!.summary!.p50).toBe(2.5);
    expect(merged.q!.error).toBe("boom");
    expect(merged.only!.samples).toEqual([5]);
  });
});
