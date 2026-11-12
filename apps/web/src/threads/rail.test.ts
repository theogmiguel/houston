import { describe, expect, it } from "vite-plus/test";

import { nextRailTargetIndex, pinnedThreadsFirst } from "./rail";

describe("nextRailTargetIndex", () => {
  const targets = [{ threadId: "a" }, { threadId: "b" }, { threadId: "c" }];

  it("walks the rail and stops at its ends", () => {
    expect(nextRailTargetIndex(targets, targets[0]!, "next")).toBe(1);
    expect(nextRailTargetIndex(targets, targets[2]!, "previous")).toBe(1);
    expect(nextRailTargetIndex(targets, targets[0]!, "previous")).toBeNull();
    expect(nextRailTargetIndex(targets, targets[2]!, "next")).toBeNull();
  });

  it("starts at the matching end when no row is focused", () => {
    expect(nextRailTargetIndex(targets, null, "next")).toBe(0);
    expect(nextRailTargetIndex(targets, null, "previous")).toBe(2);
  });
});

describe("pinnedThreadsFirst", () => {
  it("moves pinned threads to the front and keeps the order inside each group", () => {
    const rows = [
      { id: "a", pinnedAt: null },
      { id: "b", pinnedAt: "2026-01-01T00:00:00.000Z" },
      { id: "c", pinnedAt: null },
      { id: "d", pinnedAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(pinnedThreadsFirst(rows).map((row) => row.id)).toEqual(["b", "d", "a", "c"]);
  });
});
