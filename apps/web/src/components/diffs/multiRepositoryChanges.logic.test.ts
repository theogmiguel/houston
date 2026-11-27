import { describe, expect, it } from "vite-plus/test";

import {
  branchLabel,
  buildRepositoryChangeGroups,
  isMultiRepository,
  repositoryChoice,
  repositoryDisplayName,
  repositoryErrorMessage,
  resolveActiveRepository,
  resolveGitActionsRepository,
  type RepositoryChoice,
} from "./multiRepositoryChanges.logic";

const repository = (overrides: Partial<RepositoryChoice> = {}): RepositoryChoice => ({
  key: "api",
  root: "/project/api",
  name: "api",
  branch: "feature/api",
  detached: false,
  ...overrides,
});

describe("repositoryDisplayName", () => {
  it("names the project folder itself by its folder name", () => {
    expect(repositoryDisplayName({ key: ".", root: "/project" })).toBe("project");
  });

  it("names a nested repository by its last key segment", () => {
    expect(
      repositoryDisplayName({ key: "packages/client", root: "/project/packages/client" }),
    ).toBe("client");
  });

  it("names a tracked repository by its folder when the key escapes the project", () => {
    expect(repositoryDisplayName({ key: "../shared", root: "/elsewhere/shared" })).toBe("shared");
  });
});

describe("repositoryChoice", () => {
  it("keeps the error only when the repository has one", () => {
    const broken = repositoryChoice({
      key: "api",
      root: "/project/api",
      branch: null,
      detached: false,
      kind: "discovered",
      error: "permission denied",
    });
    expect(broken).toEqual({
      key: "api",
      root: "/project/api",
      name: "api",
      branch: null,
      detached: false,
      error: "permission denied",
    });
    expect(
      "error" in
        repositoryChoice({
          key: "web",
          root: "/project/web",
          branch: "main",
          detached: false,
          kind: "discovered",
        }),
    ).toBe(false);
  });
});

describe("selection", () => {
  it("treats one repository as a single-repository project", () => {
    expect(isMultiRepository([repository()])).toBe(false);
    expect(isMultiRepository([repository(), repository({ key: "web" })])).toBe(true);
  });

  it("resolves the stored key and falls back to every repository", () => {
    const repositories = [repository(), repository({ key: "web", name: "web" })];
    expect(resolveActiveRepository(repositories, "web")?.name).toBe("web");
    expect(resolveActiveRepository(repositories, "gone")).toBeNull();
    expect(resolveActiveRepository(repositories, null)).toBeNull();
  });

  it("gives git actions the selected repository or the first one", () => {
    const repositories = [repository(), repository({ key: "web", name: "web" })];
    expect(resolveGitActionsRepository(repositories, "web")?.name).toBe("web");
    expect(resolveGitActionsRepository(repositories, null)?.name).toBe("api");
    expect(resolveGitActionsRepository([], null)).toBeNull();
  });
});

describe("branchLabel", () => {
  it("prints a branch, or the detached head's short sha when known", () => {
    expect(branchLabel({ branch: "feature/api", detached: false })).toBe("feature/api");
    expect(branchLabel({ branch: null, detached: true }, "0123456789abcdef")).toBe(
      "detached 0123456",
    );
    expect(branchLabel({ branch: null, detached: true })).toBe("detached");
  });
});

describe("repositoryErrorMessage", () => {
  it("names the repository, its path and the reason", () => {
    expect(repositoryErrorMessage(repository({ error: "permission denied" }))).toBe(
      "Could not read api: /project/api — permission denied",
    );
  });
});

describe("buildRepositoryChangeGroups", () => {
  const files = (repositoryKey: string, additions: number, deletions: number) => [
    {
      path: `${repositoryKey}/file.ts`,
      additions,
      deletions,
    },
  ];

  it("keeps project order and totals each repository's files", () => {
    const repositories = [
      repository(),
      repository({ key: "web", name: "web" }),
      repository({ key: "docs", name: "docs" }),
    ];
    const groups = buildRepositoryChangeGroups(
      repositories,
      new Map([
        ["web", files("web", 4, 1)],
        ["api", files("api", 2, 3)],
      ]),
    );
    expect(groups.map((group) => group.repository.name)).toEqual(["api", "web"]);
    expect(groups.map((group) => [group.additions, group.deletions])).toEqual([
      [2, 3],
      [4, 1],
    ]);
  });

  it("keeps an unreadable repository in its place even with no files", () => {
    const groups = buildRepositoryChangeGroups(
      [repository(), repository({ key: "web", name: "web", error: "permission denied" })],
      new Map(),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.repository.key).toBe("web");
    expect(groups[0]?.files).toEqual([]);
  });

  it("omits a readable repository with no changes", () => {
    expect(buildRepositoryChangeGroups([repository()], new Map())).toEqual([]);
  });
});
