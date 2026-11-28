import { HOUSTON_PROJECT_REPOSITORY_LIMITS } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addTrackedFolderDisabledReason,
  ignorePatternsDirty,
  ignorePatternsText,
  parseIgnorePatterns,
  repositoryBranchLabel,
  repositoryFailureMessage,
  repositoryNoticeMessage,
  repositoryReadError,
  showRepositoryLists,
  splitProjectRepositories,
  TRACKED_FOLDER_WARNING_THRESHOLD,
  trackedFolderCounter,
  type ProjectRepositoryLists,
} from "./projectRepositories.logic";

type Repository = ProjectRepositoryLists["found"][number];

const repository = (overrides: Partial<Repository> = {}): Repository => ({
  key: ".",
  root: "/work/repo",
  branch: "main",
  detached: false,
  kind: "discovered",
  ...overrides,
});

describe("splitting a project's repositories", () => {
  it("keeps discovered and submodule entries found and tracked folders apart", () => {
    const tracked = repository({
      key: "../shared",
      root: "/work/shared",
      kind: "tracked",
      branch: "release",
    });
    const submodule = repository({ key: "vendor/lib", kind: "submodule", branch: "vendor" });
    const lists = splitProjectRepositories([repository(), submodule, tracked]);

    expect(lists.found.map((entry) => entry.key)).toEqual([".", "vendor/lib"]);
    expect(lists.tracked.map((entry) => entry.key)).toEqual(["../shared"]);
  });
});

describe("repository section visibility", () => {
  const visible = (input: {
    repositories?: ReadonlyArray<Repository>;
    trackedCount?: number;
    ignoredCount?: number;
    noticeCount?: number;
  }) =>
    showRepositoryLists({
      repositories: input.repositories ?? [repository()],
      trackedCount: input.trackedCount ?? 0,
      ignoredCount: input.ignoredCount ?? 0,
      noticeCount: input.noticeCount ?? 0,
    });

  it("keeps a lone readable repository compact", () => {
    expect(visible({})).toBe(false);
  });

  it("shows the lists from a second repository, a tracked folder, a pattern or a bound", () => {
    expect(visible({ repositories: [repository(), repository({ key: "one" })] })).toBe(true);
    expect(visible({ trackedCount: 1 })).toBe(true);
    expect(visible({ ignoredCount: 1 })).toBe(true);
    expect(visible({ noticeCount: 1 })).toBe(true);
  });

  it("shows the lone repository's row when it could not be read or none was found", () => {
    expect(visible({ repositories: [repository({ error: "not readable" })] })).toBe(true);
    expect(visible({ repositories: [] })).toBe(true);
  });
});

describe("tracked folder counter", () => {
  it("stays hidden below the warning threshold", () => {
    expect(trackedFolderCounter(0).visible).toBe(false);
    expect(trackedFolderCounter(TRACKED_FOLDER_WARNING_THRESHOLD - 1).visible).toBe(false);
  });

  it("warns from 112 added folders", () => {
    const counter = trackedFolderCounter(112);
    expect(counter.visible).toBe(true);
    expect(counter.tone).toBe("warning");
    expect(counter.label).toBe("112 of 128 added folders");
  });

  it("warns at the limit with the count and the limit", () => {
    const counter = trackedFolderCounter(HOUSTON_PROJECT_REPOSITORY_LIMITS.trackedFolders);
    expect(counter.tone).toBe("warning");
    expect(counter.label).toBe("128 of 128 added folders");
  });

  it("disables adding at the limit and names the operation, count and limit", () => {
    expect(addTrackedFolderDisabledReason(127)).toBeNull();
    expect(addTrackedFolderDisabledReason(128)).toBe(
      "Cannot add a folder: 128 of 128 added folders",
    );
  });
});

describe("ignore patterns", () => {
  it("trims lines, drops blanks and deduplicates in order", () => {
    expect(parseIgnorePatterns(" legacy \r\n\nvendor/**\r\nlegacy\n  \n")).toEqual([
      "legacy",
      "vendor/**",
    ]);
  });

  it("round-trips the saved list as one pattern per line", () => {
    expect(ignorePatternsText(["legacy", "vendor/**"])).toBe("legacy\nvendor/**");
  });

  it("ignores whitespace-only edits but sees added and reordered patterns", () => {
    expect(ignorePatternsDirty(["legacy", "vendor/**"], " legacy\nvendor/** \n")).toBe(false);
    expect(ignorePatternsDirty(["legacy"], "legacy\nvendor/**")).toBe(true);
    expect(ignorePatternsDirty(["legacy", "vendor/**"], "vendor/**\nlegacy")).toBe(true);
    expect(ignorePatternsDirty(["legacy"], "")).toBe(true);
  });
});

describe("repository presentation", () => {
  it("names a branch, a detached head or an unreadable entry", () => {
    expect(repositoryBranchLabel(repository())).toBe("main");
    expect(repositoryBranchLabel(repository({ branch: null, detached: true }))).toBe("detached");
    expect(repositoryBranchLabel(repository({ branch: null, error: "boom" }))).toBe("Unreadable");
  });

  it("states what could not be read with its key, path and cause", () => {
    expect(repositoryReadError(repository())).toBeNull();
    expect(
      repositoryReadError(
        repository({ key: "vendor/lib", root: "/work/repo/vendor/lib", error: "not a git repo" }),
      ),
    ).toBe("Could not read vendor/lib: /work/repo/vendor/lib (not a git repo)");
  });

  it("names the bound, the value and the requested repository for a notice", () => {
    expect(
      repositoryNoticeMessage({
        limit: "repositories",
        limitValue: 64,
        actual: 64,
        requested: "vendor/next",
      }),
    ).toBe(
      "Repository discovery hit the repository limit of 64 with 64 found; vendor/next was not returned.",
    );
    expect(
      repositoryNoticeMessage({
        limit: "submodulesPerRepository",
        limitValue: 32,
        actual: 32,
        requested: "vendor/lib",
      }),
    ).toContain("submodule limit of 32");
  });

  it("reads a failure's message when it has one", () => {
    expect(repositoryFailureMessage(new Error("64 folders is the limit"))).toBe(
      "64 folders is the limit",
    );
    expect(repositoryFailureMessage({ message: "not found" })).toBe("not found");
    expect(repositoryFailureMessage(null)).toBe("The project repositories request failed.");
  });
});
