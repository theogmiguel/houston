import { describe, expect, it } from "vite-plus/test";

import { treeGitStatus } from "./fileTreeGitStatus";

const file = (
  path: string,
  status: "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflicted",
) => ({
  path,
  insertions: 0,
  deletions: 0,
  status,
});

describe("treeGitStatus", () => {
  it("uses the worst descendant status for a folder", () => {
    const files = [file("src/a.ts", "modified"), file("src/b.ts", "deleted")];
    expect(treeGitStatus("src", true, files)).toBe("deleted");
    expect(treeGitStatus("src", false, files)).toBeNull();
  });

  it("does not match a sibling folder with the same prefix", () => {
    expect(treeGitStatus("src", true, [file("src-other/a.ts", "modified")])).toBeNull();
  });

  it("reports an untracked file and ignores entries without a status", () => {
    expect(treeGitStatus("notes.md", false, [file("notes.md", "untracked")])).toBe("untracked");
    expect(
      treeGitStatus("notes.md", false, [{ path: "notes.md", insertions: 1, deletions: 0 }]),
    ).toBeNull();
  });
});
