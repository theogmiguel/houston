import { describe, expect, it } from "vite-plus/test";

import type { MergedPullRequestList } from "./pullRequestList.logic";
import { openPullRequestCount } from "./useOpenPullRequestCount";

const list = (entryCount: number): MergedPullRequestList =>
  ({ entries: Array.from({ length: entryCount }, (_, index) => ({ number: index + 1 })) }) as never;

describe("openPullRequestCount", () => {
  it("counts the open pull requests the list shows", () => {
    expect(openPullRequestCount(list(3))).toBe(3);
  });

  it("hides an empty or unknown count", () => {
    expect(openPullRequestCount(list(0))).toBeNull();
    expect(openPullRequestCount(null)).toBeNull();
  });
});
