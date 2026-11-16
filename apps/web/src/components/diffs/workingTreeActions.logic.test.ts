import { describe, expect, it } from "vite-plus/test";

import {
  discardKindForWorkingTreeFile,
  stageActionForWorkingTreeFile,
  stageAllPaths,
} from "./workingTreeActions.logic";

describe("stageActionForWorkingTreeFile", () => {
  it("unstages a fully staged file and stages anything not in the index", () => {
    expect(stageActionForWorkingTreeFile({ path: "a.ts", staged: true })).toBe("unstage");
    expect(stageActionForWorkingTreeFile({ path: "a.ts", unstaged: true })).toBe("stage");
    expect(stageActionForWorkingTreeFile({ path: "a.ts", untracked: true })).toBe("stage");
    expect(stageActionForWorkingTreeFile({ path: "a.ts", staged: true, unstaged: true })).toBe(
      "stage",
    );
  });

  it("offers nothing for a clean or conflicted path", () => {
    expect(stageActionForWorkingTreeFile({ path: "a.ts" })).toBeNull();
    expect(stageActionForWorkingTreeFile(undefined)).toBeNull();
    expect(
      stageActionForWorkingTreeFile({
        path: "a.ts",
        conflicted: true,
        staged: true,
        unstaged: true,
      }),
    ).toBeNull();
  });
});

describe("discardKindForWorkingTreeFile", () => {
  it("says what a discard would delete, and refuses a conflicted path", () => {
    expect(discardKindForWorkingTreeFile({ path: "a.ts", untracked: true })).toBe("untracked");
    expect(discardKindForWorkingTreeFile({ path: "a.ts", staged: true })).toBe("staged");
    expect(discardKindForWorkingTreeFile({ path: "a.ts", unstaged: true })).toBe("unstaged");
    expect(
      discardKindForWorkingTreeFile({
        path: "a.ts",
        conflicted: true,
        unstaged: true,
      }),
    ).toBeNull();
  });
});

describe("stageAllPaths", () => {
  const files = [
    { path: "staged.ts", staged: true },
    { path: "unstaged.ts", unstaged: true },
    { path: "conflicted.ts", conflicted: true, unstaged: true },
  ];

  it("names every path a bulk action would change", () => {
    expect(stageAllPaths(files, "stage")).toEqual(["unstaged.ts"]);
    expect(stageAllPaths(files, "unstage")).toEqual(["staged.ts"]);
  });

  it("returns no paths when the group is empty, never stage everything", () => {
    expect(stageAllPaths([{ path: "staged.ts", staged: true }], "stage")).toEqual([]);
  });
});
