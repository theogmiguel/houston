import { scopedProjectKey, scopeProjectRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ProjectId, type HoustonProjectRepository } from "@houston-app/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import {
  PROJECT_REPOSITORY_CHOICE_STORAGE_KEY,
  readProjectRepositoryChoice,
  resetProjectRepositoryChoiceCacheForTests,
  writeProjectRepositoryChoice,
} from "~/state/worktreeRepositories";
import { WorktreeRepositoryPicker } from "./WorktreeRepositoryPicker";

const state = vi.hoisted(() => ({
  repositories: [] as ReadonlyArray<HoustonProjectRepository>,
  error: null as string | null,
}));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data:
      state.error === null
        ? {
            projectId: "project-worktree",
            repositories: state.repositories,
            ignored: [],
            notices: [],
          }
        : null,
    isPending: false,
    error: state.error,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-worktree");
const PROJECT_ID = ProjectId.make("project-worktree");
const PROJECT_KEY = scopedProjectKey(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
const captureDir = import.meta.env.VITE_HOUSTON_CAPTURE_DIR;

function repository(
  key: string,
  overrides: Partial<HoustonProjectRepository> = {},
): HoustonProjectRepository {
  return {
    key,
    root: `/project/${key}`,
    branch: "main",
    detached: false,
    kind: "discovered",
    ...overrides,
  };
}

const SEVERAL = [repository("api"), repository("web"), repository("docs")];

function PickerHarness() {
  const [baseBranch, setBaseBranch] = useState<string | null>("main");
  return (
    <div style={{ padding: "16px" }}>
      <WorktreeRepositoryPicker
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        baseBranch={baseBranch}
        fallbackBranch="main"
        onBaseBranchChange={setBaseBranch}
      />
    </div>
  );
}

async function renderPicker(repositories: ReadonlyArray<HoustonProjectRepository>) {
  state.repositories = repositories;
  state.error = null;
  return render(<PickerHarness />);
}

async function openPicker() {
  await userEvent.click(page.getByRole("button", { name: /^Repositories:/ }).element());
  await expect.element(page.getByLabelText("Base branch")).toBeVisible();
}

function resetPickerState() {
  state.repositories = [];
  state.error = null;
  window.localStorage.removeItem(PROJECT_REPOSITORY_CHOICE_STORAGE_KEY);
  resetProjectRepositoryChoiceCacheForTests();
  document.documentElement.classList.remove("dark");
}

describe("WorktreeRepositoryPicker", () => {
  it("starts with every repository chosen when there are up to eight", async () => {
    resetPickerState();
    await using _screen = await renderPicker(SEVERAL);
    await expect
      .element(page.getByRole("button", { name: "Repositories: All repositories" }))
      .toBeVisible();
    await openPicker();
    expect(page.getByRole("checkbox").elements()).toHaveLength(3);
    await expect.element(page.getByRole("checkbox", { name: /^api/ })).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: /^web/ })).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: /^docs/ })).toBeChecked();
  });

  it("starts with none and searches when there are more than eight repositories", async () => {
    resetPickerState();
    await using _screen = await renderPicker(
      Array.from({ length: 9 }, (_, index) => repository(`repo-${index}`)),
    );
    await expect
      .element(page.getByRole("button", { name: "Repositories: No repositories" }))
      .toBeVisible();
    await openPicker();
    const search = page.getByRole("searchbox", { name: "Search repositories" });
    await expect.element(search).toBeVisible();
    expect(page.getByRole("checkbox").elements()).toHaveLength(9);
    await expect.element(page.getByRole("checkbox", { name: /^repo-3/ })).not.toBeChecked();

    await userEvent.type(search.element(), "repo-3");
    expect(page.getByRole("checkbox").elements()).toHaveLength(1);
    await userEvent.click(page.getByRole("checkbox", { name: /^repo-3/ }).element());
    await expect
      .element(page.getByRole("button", { name: "Repositories: 1 of 9 repositories" }))
      .toBeVisible();
  });

  it("truncates a long repository name and branch, keeping the name wider", async () => {
    resetPickerState();
    const longKey = "repository-with-a-long-but-readable-name".padEnd(70, "-x");
    await using _screen = await renderPicker([
      repository("api"),
      repository(longKey, {
        branch: `feature/${"very-long-branch-name-".repeat(10)}end`,
      }),
    ]);
    await openPicker();
    const name = [...document.querySelectorAll<HTMLElement>("[data-repository-name]")].find(
      (element) => element.textContent?.startsWith("repository-with"),
    )!;
    const branch = name.parentElement!.querySelector<HTMLElement>("[data-repository-branch]")!;
    expect(name.querySelector("[data-overflow]")).not.toBeNull();
    expect(branch.querySelector("[data-overflow]")).not.toBeNull();
    expect(name.clientWidth).toBeGreaterThan(branch.clientWidth);
  });

  it("shows no repository trigger when the project keeps one repository", async () => {
    resetPickerState();
    await using _screen = await renderPicker([repository(".")]);
    expect(page.getByRole("button", { name: /^Repositories:/ }).elements()).toHaveLength(0);
  });

  it("shows an empty state when the project lists no repositories", async () => {
    resetPickerState();
    await using _screen = await renderPicker([]);
    await expect
      .element(page.getByRole("button", { name: "Repositories: No repositories" }))
      .toBeVisible();
    await openPicker();
    expect(document.querySelector('[data-slot="empty"]')).not.toBeNull();
    await expect
      .element(page.getByText("This project has no repository Houston can use for a worktree."))
      .toBeVisible();
  });

  it("disables an unreadable repository and names its path and reason", async () => {
    resetPickerState();
    await using _screen = await renderPicker([
      repository("api"),
      repository("broken", {
        root: "/project/broken",
        branch: null,
        error: "permission denied",
      }),
    ]);
    await expect
      .element(page.getByRole("button", { name: "Repositories: 1 of 2 repositories" }))
      .toBeVisible();
    await openPicker();
    const broken = page.getByRole("checkbox", { name: /^broken/ });
    await expect.element(broken).toBeDisabled();
    await expect
      .element(page.getByText("Could not read broken: /project/broken (permission denied)"))
      .toBeVisible();
  });

  it("takes a free-text base branch", async () => {
    resetPickerState();
    await using _screen = await renderPicker(SEVERAL);
    await openPicker();
    const input = page.getByLabelText("Base branch");
    await userEvent.clear(input.element());
    await userEvent.type(input.element(), "release");
    await expect.element(input).toHaveValue("release");
  });

  it("disables a repository without commits", async () => {
    resetPickerState();
    await using _screen = await renderPicker([
      repository("api"),
      repository("empty", { branch: null }),
    ]);
    await openPicker();
    await expect.element(page.getByRole("checkbox", { name: /^empty/ })).toBeDisabled();
    await expect.element(page.getByText("No commits yet")).toBeVisible();
  });

  it("says to choose at least one repository when none is chosen", async () => {
    resetPickerState();
    await using _screen = await renderPicker(SEVERAL);
    await openPicker();
    await userEvent.click(page.getByRole("button", { name: "None" }).element());
    await expect
      .element(page.getByText("Choose at least one repository to start a worktree."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Repositories: No repositories" }))
      .toBeVisible();
  });

  it("remembers the choice per project across a remount", async () => {
    resetPickerState();
    {
      await using _screen = await renderPicker(SEVERAL);
      await openPicker();
      await userEvent.click(page.getByRole("button", { name: "None" }).element());
    }
    await using _screen = await renderPicker(SEVERAL);
    await expect
      .element(page.getByRole("button", { name: "Repositories: No repositories" }))
      .toBeVisible();
    await openPicker();
    await expect.element(page.getByRole("checkbox", { name: /^api/ })).not.toBeChecked();
  });

  it("drops a remembered repository the project no longer has", async () => {
    resetPickerState();
    writeProjectRepositoryChoice(PROJECT_KEY, ["web", "removed"]);
    await using _screen = await renderPicker(SEVERAL);
    await expect
      .element(page.getByRole("button", { name: "Repositories: 1 of 3 repositories" }))
      .toBeVisible();
    await vi.waitFor(() => {
      expect(readProjectRepositoryChoice(PROJECT_KEY)).toEqual(["web"]);
    });
  });

  it("reports a failed repository read instead of the picker", async () => {
    resetPickerState();
    state.repositories = SEVERAL;
    state.error = "Project repositories are unavailable.";
    await using _screen = await render(<PickerHarness />);
    expect(page.getByRole("button", { name: /^Repositories:/ }).elements()).toHaveLength(0);
  });
});

type CaptureCase =
  | "several-repositories"
  | "more-than-eight"
  | "long-repository-and-branch"
  | "empty"
  | "unreadable-repository"
  | "no-commit-repository"
  | "none-chosen"
  | "one-repository";

const CAPTURE_CASES: ReadonlyArray<CaptureCase> = [
  "several-repositories",
  "more-than-eight",
  "long-repository-and-branch",
  "empty",
  "unreadable-repository",
  "no-commit-repository",
  "none-chosen",
  "one-repository",
];

function captureRepositories(name: CaptureCase): ReadonlyArray<HoustonProjectRepository> {
  switch (name) {
    case "several-repositories":
      return SEVERAL;
    case "more-than-eight":
      return Array.from({ length: 9 }, (_, index) => repository(`repo-${index}`));
    case "long-repository-and-branch":
      return [
        repository("api"),
        repository("repository-with-a-long-but-readable-name".padEnd(70, "-x"), {
          branch: `feature/${"very-long-branch-name-".repeat(10)}end`,
        }),
      ];
    case "empty":
      return [];
    case "unreadable-repository":
      return [
        repository("api"),
        repository("broken", {
          root: "/project/broken",
          branch: null,
          error: "permission denied",
        }),
      ];
    case "no-commit-repository":
      return [repository("api"), repository("empty", { branch: null })];
    case "none-chosen":
      return SEVERAL;
    case "one-repository":
      return [repository(".")];
  }
}

describe.skipIf(!captureDir)("worktree repository picker captures", () => {
  it.each(CAPTURE_CASES)("captures %s in both themes and widths", async (name) => {
    resetPickerState();
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const width of [390, 1280] as const) {
        if (name === "none-chosen") writeProjectRepositoryChoice(PROJECT_KEY, []);
        const screen = await renderPicker(captureRepositories(name));
        try {
          await page.viewport(width, 800);
          if (page.getByRole("button", { name: /^Repositories:/ }).elements().length > 0) {
            await openPicker();
          }
          await page.screenshot({
            path: `${captureDir}/composer/${name}-${theme}-${width}.png`,
          });
        } finally {
          await screen[Symbol.asyncDispose]();
        }
      }
    }
    document.documentElement.classList.remove("dark");
  });
});
