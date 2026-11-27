import { describe, expect, it } from "vite-plus/test";

import {
  defaultRepositorySelection,
  filterWorktreeRepositories,
  repositoryKeysForSend,
  repositorySelectionLabel,
  resolveRepositoryBaseBranch,
  resolveRepositorySelection,
  WORKTREE_REPOSITORY_SEND_BLOCK_REASON,
  worktreeRepositoryDisabledReason,
  worktreeRepositorySendBlockReason,
  type WorktreeRepositoryChoice,
} from "./worktreeRepositories.logic";

function repository(
  key: string,
  overrides: Partial<WorktreeRepositoryChoice> = {},
): WorktreeRepositoryChoice {
  return {
    key,
    name: key,
    root: `/project/${key}`,
    branch: "main",
    ...overrides,
  };
}

const several = [repository("api"), repository("web"), repository("docs")];

describe("defaultRepositorySelection", () => {
  it("selects every readable repository up to the search threshold", () => {
    expect(defaultRepositorySelection(several)).toEqual(["api", "web", "docs"]);
    expect(
      defaultRepositorySelection(
        Array.from({ length: 8 }, (_, index) => repository(`repo-${index}`)),
      ),
    ).toHaveLength(8);
  });

  it("starts with none when the picker searches more than eight repositories", () => {
    expect(
      defaultRepositorySelection(
        Array.from({ length: 9 }, (_, index) => repository(`repo-${index}`)),
      ),
    ).toEqual([]);
  });

  it("never defaults to a disabled repository", () => {
    expect(
      defaultRepositorySelection([
        repository("api"),
        repository("broken", { branch: null, error: "permission denied" }),
      ]),
    ).toEqual(["api"]);
  });
});

describe("resolveRepositorySelection", () => {
  it("keeps a remembered selection that still exists", () => {
    expect(resolveRepositorySelection({ remembered: ["web"], repositories: several })).toEqual([
      "web",
    ]);
  });

  it("keeps an explicit empty selection even below the threshold", () => {
    expect(resolveRepositorySelection({ remembered: [], repositories: several })).toEqual([]);
  });

  it("drops an unknown remembered key and keeps the rest", () => {
    expect(
      resolveRepositorySelection({ remembered: ["web", "removed"], repositories: several }),
    ).toEqual(["web"]);
  });

  it("falls back to the default when no remembered key remains", () => {
    expect(resolveRepositorySelection({ remembered: ["removed"], repositories: several })).toEqual([
      "api",
      "web",
      "docs",
    ]);
  });

  it("applies the default to a project with no remembered choice", () => {
    expect(resolveRepositorySelection({ remembered: null, repositories: several })).toEqual([
      "api",
      "web",
      "docs",
    ]);
  });
});

describe("repositorySelectionLabel", () => {
  it("summarises none, all and a partial choice", () => {
    expect(repositorySelectionLabel(0, 5)).toBe("No repositories");
    expect(repositorySelectionLabel(5, 5)).toBe("All repositories");
    expect(repositorySelectionLabel(2, 5)).toBe("2 of 5 repositories");
    expect(repositorySelectionLabel(0, 0)).toBe("No repositories");
  });
});

describe("worktreeRepositoryDisabledReason", () => {
  it("names the repository, its path and why it could not be read", () => {
    expect(
      worktreeRepositoryDisabledReason(
        repository("broken", { root: "/project/broken", branch: null, error: "permission denied" }),
      ),
    ).toBe("Could not read broken: /project/broken (permission denied)");
  });

  it("reports a repository without commits", () => {
    expect(worktreeRepositoryDisabledReason(repository("empty", { branch: null }))).toBe(
      "No commits yet",
    );
  });

  it("accepts a readable repository", () => {
    expect(worktreeRepositoryDisabledReason(repository("api"))).toBeNull();
  });
});

describe("filterWorktreeRepositories", () => {
  it("matches the name, key or branch and ignores case", () => {
    const repositories = [
      repository("api", { name: "Backend API", branch: "feature/login" }),
      repository("web", { name: "Website", branch: "main" }),
    ];
    expect(filterWorktreeRepositories(repositories, "backend")).toEqual([repositories[0]]);
    expect(filterWorktreeRepositories(repositories, "LOGIN")).toEqual([repositories[0]]);
    expect(filterWorktreeRepositories(repositories, "web")).toEqual([repositories[1]]);
    expect(filterWorktreeRepositories(repositories, "  ")).toEqual(repositories);
  });
});

describe("worktreeRepositorySendBlockReason", () => {
  it("blocks a multi-repository worktree with no repository chosen", () => {
    expect(
      worktreeRepositorySendBlockReason({ usesRepositoryChoice: true, selectedCount: 0 }),
    ).toBe(WORKTREE_REPOSITORY_SEND_BLOCK_REASON);
  });

  it("allows a send once a repository is chosen or the project keeps one repository", () => {
    expect(
      worktreeRepositorySendBlockReason({ usesRepositoryChoice: true, selectedCount: 1 }),
    ).toBeNull();
    expect(
      worktreeRepositorySendBlockReason({ usesRepositoryChoice: false, selectedCount: 0 }),
    ).toBeNull();
  });
});

describe("repositoryKeysForSend", () => {
  it("sends the explicit chosen keys for a multi-repository project", () => {
    expect(
      repositoryKeysForSend({ usesRepositoryChoice: true, selectedKeys: ["web", "api"] }),
    ).toEqual(["web", "api"]);
  });

  it("omits the keys when the project keeps one repository", () => {
    expect(
      repositoryKeysForSend({ usesRepositoryChoice: false, selectedKeys: ["."] }),
    ).toBeUndefined();
  });
});

describe("resolveRepositoryBaseBranch", () => {
  it("prefers the typed branch, then the checkout branch, then HEAD", () => {
    expect(resolveRepositoryBaseBranch({ typed: "release", fallback: "main" })).toBe("release");
    expect(resolveRepositoryBaseBranch({ typed: "  ", fallback: "main" })).toBe("main");
    expect(resolveRepositoryBaseBranch({ typed: null, fallback: null })).toBe("HEAD");
  });
});
