import { RegistryContext } from "@effect/atom-react";
import type { VcsStatusResult } from "@houston-app/contracts";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@houston-app/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render as renderScreen } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

import GitActionsControl from "./GitActionsControl";
import { useActiveRepositoryStore } from "~/state/activeRepository";
import type { RepositoryChoice } from "./diffs/multiRepositoryChanges.logic";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";

const captureDir = import.meta.env.VITE_HOUSTON_CAPTURE_DIR;

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  repositories: [] as ReadonlyArray<RepositoryChoice>,
  statuses: new Map<string, ResultAtom<VcsStatusResult>>(),
  worktrees: new Map<string, ResultAtom<{ worktrees: Array<Record<string, unknown>> }>>(),
  idleStatus: null as unknown as ResultAtom<VcsStatusResult>,
  actionState: null as unknown as Atom.Atom<{
    isRunning: boolean;
    operation: string | null;
    currentLabel: string | null;
    lastOutputLine: string | null;
    phaseStartedAtMs: number | null;
    hookStartedAtMs: number | null;
  }>,
  revalidationAtom: null as unknown as Atom.Atom<null>,
  config: null as unknown as Atom.Atom<null>,
  repositoryRefreshCount: 0,
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: ({ input }: { input: { cwd: string } }) =>
      state.statuses.get(input.cwd) ?? state.idleStatus,
    listWorktrees: ({ input }: { input: { cwd: string } }) =>
      state.worktrees.get(input.cwd) ?? Atom.make(AsyncResult.success({ worktrees: [] })),
    refreshStatus: {},
    amendCommit: {},
    fetch: {},
    stageFiles: {},
    unstageFiles: {},
    discardFiles: {},
  },
  vcsActionManager: { stateAtom: () => state.actionState },
  vcsStatusRevalidation: () => state.revalidationAtom,
}));
vi.mock("~/state/threadRepositories", () => ({
  useThreadRepositories: () => ({
    repositories: state.repositories,
    isLoading: false,
    error: null,
    refresh: () => {
      state.repositoryRefreshCount += 1;
    },
  }),
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => state.thread,
  useQuietThreadProjection: () => null,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/sourceControlActions", () => ({
  useGitStackedAction: () => ({ run: async () => null }),
  useSourceControlActionRunning: () => false,
  useSourceControlPublishRepositoryAction: () => ({ run: async () => null, isPending: false }),
  useVcsInitAction: () => ({ run: async () => null, isPending: false }),
  useVcsPullAction: () => ({ run: async () => null }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("~/hooks/useDeadline", () => ({ useDeadlinePassed: () => false }));
vi.mock("~/hooks/useNowSecond", () => ({ useNowSecond: () => 0 }));

const apiRepository: RepositoryChoice = {
  key: "api",
  root: "/project/api",
  name: "api",
  branch: "feature/api",
  detached: false,
};
const webRepository: RepositoryChoice = {
  key: "web",
  root: "/project/web",
  name: "web",
  branch: "feature/web",
  detached: false,
};

function statusFor(
  root: string,
  files: ReadonlyArray<{ path: string; insertions: number; deletions: number }> = [],
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      rootPath: root,
      files: files.map((file) => ({ ...file, status: "modified" })),
      insertions: files.reduce((total, file) => total + file.insertions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function setup(
  repositories: ReadonlyArray<RepositoryChoice>,
  statuses: Record<string, VcsStatusResult> = {},
) {
  useActiveRepositoryStore.setState({ byThreadKey: {} });
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "feature",
    worktreePath: null,
  });
  state.repositories = repositories;
  state.statuses.clear();
  state.worktrees.clear();
  for (const [root, status] of Object.entries(statuses)) {
    state.statuses.set(root, Atom.make(AsyncResult.success(status)));
  }
  state.idleStatus = Atom.make(AsyncResult.success(statusFor("/project", [], { refName: null })));
  state.actionState = Atom.make({
    isRunning: false,
    operation: null,
    currentLabel: null,
    lastOutputLine: null,
    phaseStartedAtMs: null,
    hookStartedAtMs: null,
  });
  state.revalidationAtom = Atom.make(null);
  state.config = Atom.make(null);
  state.repositoryRefreshCount = 0;
  const registry = AtomRegistry.make();
  return {
    registry,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      useActiveRepositoryStore.setState({ byThreadKey: {} });
    },
  };
}

async function renderControl(
  registry: ReturnType<typeof AtomRegistry.make>,
  threadRef: ScopedThreadRef,
) {
  const container = document.createElement("div");
  container.style.width = "280px";
  return renderScreen(
    <RegistryContext.Provider value={registry}>
      <GitActionsControl
        gitCwd="/project"
        activeThreadRef={threadRef}
        showActions
        showChanges
        onOpenChanges={() => {}}
      />
    </RegistryContext.Provider>,
    { container },
  );
}

it("lists every repository and acts on the selected one", async () => {
  using context = setup([apiRepository, webRepository], {
    "/project/api": statusFor("/project/api", [{ path: "api.ts", insertions: 2, deletions: 1 }]),
    "/project/web": statusFor("/project/web", [{ path: "web.ts", insertions: 4, deletions: 0 }]),
  });
  await using screen = await renderControl(context.registry, context.threadRef);

  await expect.element(screen.getByRole("group", { name: "Repositories" })).toBeVisible();
  const apiRow = screen.getByRole("button", { name: /^api/ });
  const webRow = screen.getByRole("button", { name: /^web/ });
  await expect.element(apiRow).toHaveAttribute("aria-pressed", "true");
  await expect.element(webRow).toHaveAttribute("aria-pressed", "false");
  await expect.element(screen.getByText(/· api/, { exact: false })).toBeVisible();

  await userEvent.click(webRow);
  await expect.element(webRow).toHaveAttribute("aria-pressed", "true");
  await expect.element(apiRow).toHaveAttribute("aria-pressed", "false");
  await expect.element(screen.getByText(/· web/, { exact: false })).toBeVisible();
  expect(useActiveRepositoryStore.getState().byThreadKey).toEqual({
    [scopedThreadKey(context.threadRef)]: "web",
  });
});

it("keeps a single-repository thread free of the repository list", async () => {
  using context = setup([apiRepository], {
    "/project/api": statusFor("/project/api"),
  });
  await using screen = await renderControl(context.registry, context.threadRef);
  expect(screen.getByRole("group", { name: "Repositories" }).elements()).toHaveLength(0);
  expect(screen.getByText(/· api/, { exact: false }).elements()).toHaveLength(0);
});

it("shows a detached head's sha and refuses push and pull requests with a reason", async () => {
  const detached: RepositoryChoice = {
    key: "api",
    root: "/project/api",
    name: "api",
    branch: null,
    detached: true,
  };
  using context = setup([detached, webRepository], {
    "/project/api": statusFor("/project/api", [{ path: "api.ts", insertions: 1, deletions: 0 }], {
      refName: null,
    }),
    "/project/web": statusFor("/project/web"),
  });
  state.worktrees.set(
    "/project/api",
    Atom.make(
      AsyncResult.success({
        worktrees: [
          {
            path: "/project/api",
            refName: null,
            headSha: "0123456789abcdef",
            isMain: true,
            isBare: false,
            isDetached: true,
          },
        ],
      }),
    ),
  );
  await using screen = await renderControl(context.registry, context.threadRef);

  await expect.element(screen.getByText("detached 0123456")).toBeVisible();
  const disabled = screen.getByText(/Commit · api/, { exact: false });
  await expect.element(disabled).toBeVisible();
  await userEvent.hover(disabled);
  await expect
    .element(
      screen.getByText(/Create and checkout a ref before pushing or opening a/, { exact: false }),
    )
    .toBeVisible();
});

it("shows an unreadable repository in the list and refuses its actions", async () => {
  const broken: RepositoryChoice = {
    key: "broken",
    root: "/project/broken",
    name: "broken",
    branch: null,
    detached: false,
    error: "permission denied",
  };
  using context = setup([broken, webRepository], {
    "/project/web": statusFor("/project/web"),
  });
  await using screen = await renderControl(context.registry, context.threadRef);
  await expect
    .element(
      screen.getByText("Could not read broken: /project/broken — permission denied", {
        exact: true,
      }),
    )
    .toBeVisible();
});

it("keeps a long repository name readable while its branch truncates first", async () => {
  const longName = "repository-readable-name";
  const longBranch = `feature/${"very-long-branch-name-".repeat(10)}end`;
  const longRepository: RepositoryChoice = {
    key: "long",
    root: "/project/long",
    name: longName,
    branch: longBranch,
    detached: false,
  };
  using context = setup([apiRepository, longRepository], {
    "/project/api": statusFor("/project/api"),
    "/project/long": statusFor("/project/long", [], { refName: longBranch }),
  });
  await using screen = await renderControl(context.registry, context.threadRef);
  const name = screen.getByText(longName, { exact: true }).element();
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
  const branch = screen.container.querySelector<HTMLElement>(`[title="${longBranch}"]`);
  expect(branch).not.toBeNull();
  expect(branch!.querySelector("[data-overflow]")).not.toBeNull();
});

it("lists clean repositories with zero totals when nothing changed", async () => {
  using context = setup([apiRepository, webRepository], {
    "/project/api": statusFor("/project/api"),
    "/project/web": statusFor("/project/web"),
  });
  await using screen = await renderControl(context.registry, context.threadRef);
  await expect.element(screen.getByRole("button", { name: /^api/ })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /^web/ })).toBeVisible();
});

it("unmounts without a repository list for a single worktree repository", async () => {
  using context = setup([apiRepository], { "/project/api": statusFor("/project/api") });
  state.thread = makeThreadFixture({
    ...context.threadRef,
    id: context.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "feature",
    worktreePath: "/project/api",
  });
  await using screen = await renderControl(context.registry, context.threadRef);
  expect(screen.getByRole("group", { name: "Repositories" }).elements()).toHaveLength(0);
});

type GitActionsCaptureCase =
  | "several-repositories"
  | "long-repository-and-branch"
  | "one-repository"
  | "empty"
  | "unreadable-repository"
  | "detached-head";

const GIT_ACTIONS_CAPTURE_CASES: ReadonlyArray<GitActionsCaptureCase> = [
  "several-repositories",
  "long-repository-and-branch",
  "one-repository",
  "empty",
  "unreadable-repository",
  "detached-head",
];

function gitActionsCaptureContext(name: GitActionsCaptureCase) {
  switch (name) {
    case "long-repository-and-branch": {
      const longName = "repository-with-a-long-but-readable-name";
      const longBranch = `feature/${"very-long-branch-name-".repeat(10)}end`;
      return setup(
        [
          apiRepository,
          {
            key: "long",
            root: "/project/long",
            name: longName,
            branch: longBranch,
            detached: false,
          },
        ],
        {
          "/project/api": statusFor("/project/api", [
            { path: "api.ts", insertions: 2, deletions: 1 },
          ]),
          "/project/long": statusFor("/project/long", [], { refName: longBranch }),
        },
      );
    }
    case "one-repository":
      return setup([{ ...apiRepository, key: ".", root: "/project", name: "project" }], {
        "/project": statusFor("/project", [{ path: "api.ts", insertions: 2, deletions: 1 }]),
      });
    case "empty":
      return setup([apiRepository, webRepository], {
        "/project/api": statusFor("/project/api"),
        "/project/web": statusFor("/project/web"),
      });
    case "unreadable-repository":
      return setup(
        [
          {
            key: "broken",
            root: "/project/broken",
            name: "broken",
            branch: null,
            detached: false,
            error: "permission denied",
          },
          webRepository,
        ],
        { "/project/web": statusFor("/project/web") },
      );
    case "detached-head": {
      const context = setup(
        [
          { key: "api", root: "/project/api", name: "api", branch: null, detached: true },
          webRepository,
        ],
        {
          "/project/api": statusFor(
            "/project/api",
            [{ path: "api.ts", insertions: 1, deletions: 0 }],
            { refName: null },
          ),
          "/project/web": statusFor("/project/web"),
        },
      );
      state.worktrees.set(
        "/project/api",
        Atom.make(
          AsyncResult.success({
            worktrees: [
              {
                path: "/project/api",
                refName: null,
                headSha: "0123456789abcdef",
                isMain: true,
                isBare: false,
                isDetached: true,
              },
            ],
          }),
        ),
      );
      return context;
    }
    case "several-repositories":
      return setup([apiRepository, webRepository], {
        "/project/api": statusFor("/project/api", [
          { path: "api.ts", insertions: 2, deletions: 1 },
        ]),
        "/project/web": statusFor("/project/web", [
          { path: "web.ts", insertions: 4, deletions: 0 },
        ]),
      });
  }
}

describe.skipIf(!captureDir)("git actions captures", () => {
  it.each(GIT_ACTIONS_CAPTURE_CASES)("captures %s in both themes and widths", async (name) => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const width of [390, 1280] as const) {
        const context = gitActionsCaptureContext(name);
        const screen = await renderControl(context.registry, context.threadRef);
        try {
          await page.viewport(width, 800);
          await page.screenshot({
            element: screen.container,
            path: `${captureDir}/git-actions/${name}-${theme}-${width}.png`,
          });
        } finally {
          await screen[Symbol.asyncDispose]();
          context[Symbol.dispose]();
        }
      }
    }
    document.documentElement.classList.remove("dark");
  });
});
