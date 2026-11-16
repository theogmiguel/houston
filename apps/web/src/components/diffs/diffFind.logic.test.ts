import { describe, expect, it } from "vite-plus/test";

import { findDiffMatches, stepFindMatch, type FindableFileDiff } from "./diffFind.logic";

const file: FindableFileDiff = {
  deletionLines: ["one", "two", "three"],
  additionLines: ["one", "two changed", "three", "four"],
  hunks: [
    {
      additionStart: 1,
      additionCount: 4,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 3,
      deletionLineIndex: 0,
    },
  ],
};

describe("findDiffMatches", () => {
  it("finds text on both sides with their file line numbers", () => {
    expect(findDiffMatches(file, "two", false)).toEqual([
      { side: "deletions", lineNumber: 2 },
      { side: "additions", lineNumber: 2 },
    ]);
  });

  it("honours case and returns nothing for an empty query", () => {
    expect(findDiffMatches(file, "TWO", false)).toHaveLength(2);
    expect(findDiffMatches(file, "TWO", true)).toEqual([]);
    expect(findDiffMatches(file, "", false)).toEqual([]);
  });
});

describe("stepFindMatch", () => {
  it("wraps in both directions and stays put with no matches", () => {
    expect(stepFindMatch(0, 3, 1)).toBe(1);
    expect(stepFindMatch(2, 3, 1)).toBe(0);
    expect(stepFindMatch(0, 3, -1)).toBe(2);
    expect(stepFindMatch(0, 0, 1)).toBe(0);
  });
});
