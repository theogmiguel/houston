import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSubtitleSegments } from "./ThreadCommandSubtitle.logic";

const empty = { hasPullRequest: false, showHarness: false, isCurrent: false };

describe("resolveThreadSubtitleSegments", () => {
  it("is empty when every field is missing", () => {
    expect(resolveThreadSubtitleSegments(empty)).toEqual([]);
  });

  it("drops a blank project or branch instead of leaving an empty slot", () => {
    expect(
      resolveThreadSubtitleSegments({
        ...empty,
        projectTitle: "  ",
        branch: "",
        showHarness: true,
      }),
    ).toEqual(["harness"]);
  });

  it("keeps a harness mark next to the project when there is no pull request", () => {
    expect(
      resolveThreadSubtitleSegments({ ...empty, projectTitle: "Local", showHarness: true }),
    ).toEqual(["project", "harness"]);
  });

  it("orders every present segment", () => {
    expect(
      resolveThreadSubtitleSegments({
        projectTitle: "Houston",
        branch: "main",
        hasPullRequest: true,
        showHarness: true,
        isCurrent: true,
      }),
    ).toEqual(["project", "branch", "pullRequest", "harness", "current"]);
  });
});
