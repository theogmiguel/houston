import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientSettings,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render as renderScreen } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

const captureDir = import.meta.env.VITE_HOUSTON_CAPTURE_DIR;

// The default browser viewport is phone-sized; these cases cover the desktop panel.
async function render(...args: Parameters<typeof renderScreen>) {
  await page.viewport(1280, 800);
  return renderScreen(...args);
}

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  previewsByCwd: new Map<string, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  theme: "dark" as "dark" | "light",
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  statusesByCwd: new Map<string, ResultAtom<VcsStatusResult>>(),
  repositories: [] as ReadonlyArray<RepositoryChoice>,
  repositoryRefreshCount: 0,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string; cwd?: string } }) =>
      state.previewsByCwd.get(input.cwd ?? "") ?? state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: () => state.patch,
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: ({ input }: { input: { cwd?: string } }) =>
      state.statusesByCwd.get(input.cwd ?? "") ?? state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
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
  useProject: () => ({ workspaceRoot: "/project", repositoryIdentity: null }),
  useThreadCheckpointSummaries: () => [],
  useQuietThreadVisibleTurnItems: () => [],
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({
  useThreadRouteRef: () => state.threadRef,
  useThreadRouteTarget: () => null,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: state.diffFilesCollapsed }),
  updateClientSettings: async () => {},
}));
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => state.theme,
  getRenderedAppearance: () => state.theme,
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
// The test drives comparison controls, without mounting virtualized diff viewers or their workers.
vi.mock("./diffs/AnnotatableCodeView", async () => {
  const { useComposerDraftStore } = await import("~/composerDraftStore");
  return {
    AnnotatableCodeView: ({
      composerDraftTarget,
      onCommentAdded,
      options,
    }: {
      composerDraftTarget: ScopedThreadRef | DraftId;
      onCommentAdded?: (commentId: string) => void;
      options?: { overflow?: string };
    }) => (
      <button
        type="button"
        data-code-overflow={options?.overflow}
        onClick={() => {
          useComposerDraftStore.getState().addReviewComment(composerDraftTarget, {
            id: "diff-comment-1",
            sectionId: "branch",
            sectionTitle: "Changes",
            filePath: "src/app.ts",
            startIndex: 0,
            endIndex: 1,
            rangeLabel: "L1 to L2",
            text: "Check this",
            diff: "@@ -1,2 +1,2 @@\n-old\n+new\n",
          });
          onCommentAdded?.("diff-comment-1");
        }}
      >
        Add diff comment
      </button>
    ),
  };
});
vi.mock("./diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("./diffs/DiffFileTree", () => ({ DiffFileTree: () => null }));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));

import DiffPanel from "./DiffPanel";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { useActiveRepositoryStore } from "~/state/activeRepository";
import type { RepositoryChoice } from "./diffs/multiRepositoryChanges.logic";

const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(diff = ""): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff,
        diffHash: diff ? "patch" : "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null, diff = "") {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      keepSelectionOnOpenThreadKey: null,
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    useActiveRepositoryStore.setState({ byThreadKey: {} });
    state.previewsByCwd.clear();
    state.statusesByCwd.clear();
    state.repositories = [];
    state.repositoryRefreshCount = 0;
  };
  reset();
  state.diffFilesCollapsed = false;
  state.theme = "dark";
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.patch = patch;
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview(diff))));
  state.previews.set("main", Atom.make(AsyncResult.success(preview(diff))));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

const samplePatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " context",
  "",
].join("\n");

function panel(
  registry: ReturnType<typeof AtomRegistry.make>,
  threadRef: ScopedThreadRef,
  mode?: "sheet" | "embedded",
) {
  return (
    <RegistryContext.Provider value={registry}>
      <DiffPanel
        {...(mode ? { mode } : {})}
        composerDraftTarget={threadRef}
        workspaceMutationId={null}
        visible
      />
    </RegistryContext.Provider>
  );
}

it("keeps the view controls in the header and folds them into a menu when narrow", async () => {
  using context = setup("origin/orphan", samplePatch);
  const wide = document.createElement("div");
  wide.style.width = "700px";
  await using wideScreen = await render(panel(context.registry, context.threadRef, "sheet"), {
    container: wide,
  });
  await expect
    .element(wideScreen.getByRole("button", { name: "Enable diff line wrapping" }))
    .toBeVisible();
  // Wrapping is off by default and the header carries one overflow menu, not two.
  expect(wideScreen.getByRole("button", { name: "Diff options" }).elements()).toHaveLength(1);

  const narrow = document.createElement("div");
  narrow.style.width = "320px";
  await using narrowScreen = await render(panel(context.registry, context.threadRef, "sheet"), {
    container: narrow,
  });
  await expect.element(narrowScreen.getByRole("button", { name: "Diff options" })).toBeVisible();
  expect(
    narrowScreen.getByRole("button", { name: "Enable diff line wrapping" }).elements(),
  ).toHaveLength(0);
  expect(narrowScreen.getByRole("button", { name: "Diff options" }).elements()).toHaveLength(1);
});

it("keeps code unwrapped in the embedded side panel so the overflow fade can show", async () => {
  using context = setup(null, samplePatch);
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  const sidePanel = document.createElement("div");
  sidePanel.style.width = "400px";
  await using side = await render(panel(context.registry, context.threadRef, "embedded"), {
    container: sidePanel,
  });
  await expect
    .element(side.getByRole("button", { name: "Add diff comment" }))
    .toHaveAttribute("data-code-overflow", "scroll");
});

it("names Changes once: the embedded panel leaves the heading to its tab, a sheet keeps it", async () => {
  using context = setup(null, samplePatch);
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  const heading = (root: HTMLElement) =>
    [...root.querySelectorAll("span")].filter(
      (span) => span.textContent === "Changes" && span.className.includes("text-headline"),
    );
  const embeddedRoot = document.createElement("div");
  embeddedRoot.style.width = "400px";
  await using embedded = await render(panel(context.registry, context.threadRef, "embedded"), {
    container: embeddedRoot,
  });
  await expect
    .element(embedded.getByRole("button", { name: "Add diff comment" }))
    .toBeInTheDocument();
  expect(heading(embeddedRoot)).toHaveLength(0);

  const sheetRoot = document.createElement("div");
  sheetRoot.style.width = "700px";
  await using sheet = await render(panel(context.registry, context.threadRef, "sheet"), {
    container: sheetRoot,
  });
  await expect.element(sheet.getByRole("button", { name: "Add diff comment" })).toBeInTheDocument();
  expect(heading(sheetRoot)).toHaveLength(1);
});

it("labels the comparison target so the 400px header reads on its own", async () => {
  using context = setup(null, samplePatch);
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  const root = document.createElement("div");
  root.style.width = "400px";
  await using screen = await render(panel(context.registry, context.threadRef, "embedded"), {
    container: root,
  });
  await expect
    .element(screen.getByRole("button", { name: "Add diff comment" }))
    .toBeInTheDocument();
  const label = [...root.querySelectorAll<HTMLElement>("span[aria-hidden]")].find(
    (span) => span.textContent === "Against",
  );
  expect(label).toBeDefined();
  expect(getComputedStyle(label!).display).not.toBe("none");
  expect(root.textContent).not.toMatch(/\bvs\b/);
  const trigger = root.querySelector<HTMLElement>('[aria-label^="Change comparison target"]')!;
  expect(label!.getBoundingClientRect().right).toBeLessThanOrEqual(
    trigger.getBoundingClientRect().left,
  );
});

it("offers undo for the comments it added to the composer", async () => {
  using context = setup(null, samplePatch);
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using screen = await render(panel(context.registry, context.threadRef));
  await userEvent.click(screen.getByRole("button", { name: "Add diff comment" }));
  await expect.element(screen.getByText("1 comment added to the composer")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await expect.element(screen.getByText("1 comment added to the composer")).not.toBeInTheDocument();
  expect(
    useComposerDraftStore.getState().getComposerDraft(context.threadRef)?.reviewComments ?? [],
  ).toEqual([]);
});

it.each([false, true])(
  "expands an unloaded file on the first click with default collapse %s",
  async (collapsed) => {
    using context = setup("origin/orphan");
    state.diffFilesCollapsed = collapsed;
    const path = `pending-${collapsed}.txt`;
    const metadata = preview();
    const source = {
      ...metadata.sources[0]!,
      files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
    };
    state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
        </div>
      </RegistryContext.Provider>,
    );
    const toggle = screen.getByRole("button", { name: `Expand ${path}`, exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    act(() =>
      context.registry.set(
        context.patch,
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
        }),
      ),
    );
    const loadedToggle = screen.getByRole("button", { name: `Collapse ${path}`, exact: true });
    await expect.element(loadedToggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(loadedToggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  },
);

function repositoryPreview(
  cwd: string,
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
  options: { diff?: string; patchesDeferred?: boolean } = {},
): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: options.diff ?? "",
        diffHash: options.diff ? "patch" : "empty",
        truncated: false,
        patchesDeferred: options.patchesDeferred ?? true,
        files: files.map((file) => ({ ...file, previousPath: null })),
      },
    ],
  };
}

function repositoryStatus(
  root: string,
  files: ReadonlyArray<{ path: string; insertions: number; deletions: number }>,
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "dev",
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
  };
}

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

function multiRepositorySetup(
  repositories: ReadonlyArray<RepositoryChoice>,
  {
    previews = {},
    statuses = {},
  }: {
    previews?: Record<string, ReviewDiffPreviewResult>;
    statuses?: Record<string, VcsStatusResult>;
  } = {},
) {
  const context = setup(null);
  state.thread = makeThreadFixture({
    ...context.threadRef,
    id: context.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: null,
  });
  state.repositories = repositories;
  for (const [cwd, preview] of Object.entries(previews)) {
    state.previewsByCwd.set(cwd, Atom.make(AsyncResult.success(preview)));
  }
  for (const [cwd, status] of Object.entries(statuses)) {
    state.statusesByCwd.set(cwd, Atom.make(AsyncResult.success(status)));
  }
  return context;
}

function renderEmbedded(
  registry: ReturnType<typeof AtomRegistry.make>,
  threadRef: ScopedThreadRef,
  width = 700,
) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return render(panel(registry, threadRef, "embedded"), { container });
}

it("groups a multi-repository thread's changes by repository", async () => {
  using context = multiRepositorySetup([apiRepository, webRepository], {
    previews: {
      "/project/api": repositoryPreview("/project/api", [
        { path: "api.ts", additions: 3, deletions: 1 },
      ]),
      "/project/web": repositoryPreview("/project/web", [
        { path: "web.ts", additions: 2, deletions: 0 },
      ]),
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);

  const select = screen.getByRole("combobox", { name: "Repository" });
  await expect.element(select).toBeVisible();
  await expect.element(select).toHaveTextContent("All repositories");
  await expect.element(screen.getByRole("button", { name: "Collapse api" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Collapse web" })).toBeVisible();
  await expect.element(screen.getByText("api.ts")).toBeVisible();
  await expect.element(screen.getByText("web.ts")).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "3 additions, 1 deletions" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "2 additions, 0 deletions" }))
    .toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Collapse api" }));
  await expect.element(screen.getByRole("button", { name: "Expand api" })).toBeVisible();
  await expect.element(screen.getByText("api.ts")).not.toBeInTheDocument();
  await expect.element(screen.getByText("web.ts")).toBeVisible();
});

it("narrows the changes to the repository picked from the repository select", async () => {
  using context = multiRepositorySetup([apiRepository, webRepository], {
    previews: {
      "/project/api": repositoryPreview("/project/api", [
        { path: "api.ts", additions: 3, deletions: 1 },
      ]),
      "/project/web": repositoryPreview("/project/web", [
        { path: "web.ts", additions: 2, deletions: 0 },
      ]),
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  await userEvent.click(screen.getByRole("combobox", { name: "Repository" }));
  await userEvent.click(page.getByRole("option", { name: "web", exact: true }));

  expect(screen.getByText("web.ts").elements().length).toBeGreaterThan(0);
  expect(screen.getByText("api.ts").elements()).toHaveLength(0);
  expect(useActiveRepositoryStore.getState().byThreadKey).toEqual({
    [scopedThreadKey(context.threadRef)]: "web",
  });
  await expect
    .element(screen.getByRole("combobox", { name: "Repository" }))
    .toHaveTextContent("web");
});

it("opens a file picked from another repository's group in that repository", async () => {
  using context = multiRepositorySetup([apiRepository, webRepository], {
    previews: {
      "/project/api": repositoryPreview(
        "/project/api",
        [{ path: "api.ts", additions: 3, deletions: 1 }],
        { diff: samplePatch, patchesDeferred: false },
      ),
      "/project/web": repositoryPreview("/project/web", [
        { path: "web.ts", additions: 2, deletions: 0 },
      ]),
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  await userEvent.click(screen.getByRole("button", { name: /api\.ts/ }));

  expect(useActiveRepositoryStore.getState().byThreadKey).toEqual({
    [scopedThreadKey(context.threadRef)]: "api",
  });
  await expect
    .element(screen.getByRole("combobox", { name: "Repository" }))
    .toHaveTextContent("api");
  await expect.element(screen.getByRole("button", { name: "Add diff comment" })).toBeVisible();
});

it("asks for a repository before it shows commits in a multi-repository thread", async () => {
  using context = multiRepositorySetup([apiRepository, webRepository], {
    previews: {
      "/project/api": repositoryPreview("/project/api", []),
      "/project/web": repositoryPreview("/project/web", []),
    },
  });
  useDiffPanelStore.getState().selectCommit(context.threadRef, "abc1234");
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  await expect.element(screen.getByText("Pick a repository to see its commits.")).toBeVisible();

  await userEvent.click(screen.getByRole("combobox", { name: "Repository" }));
  await userEvent.click(page.getByRole("option", { name: "web", exact: true }));
  await expect
    .element(screen.getByText("Pick a repository to see its commits."))
    .not.toBeInTheDocument();
  expect(useActiveRepositoryStore.getState().byThreadKey).toEqual({
    [scopedThreadKey(context.threadRef)]: "web",
  });
});

it("keeps a single-repository project free of a repository picker or group", async () => {
  using context = multiRepositorySetup(
    [{ ...apiRepository, key: ".", root: "/project", name: "project" }],
    {
      previews: {
        "/project": repositoryPreview("/project", [{ path: "api.ts", additions: 3, deletions: 1 }]),
      },
    },
  );
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  expect(screen.getByRole("combobox", { name: "Repository" }).elements()).toHaveLength(0);
  expect(screen.getByRole("button", { name: /Collapse api/ }).elements()).toHaveLength(0);
  expect(screen.getByText("api.ts").elements().length).toBeGreaterThan(0);
});

it("says no repository has changes when every group is empty", async () => {
  using context = multiRepositorySetup([apiRepository, webRepository], {
    previews: {
      "/project/api": repositoryPreview("/project/api", []),
      "/project/web": repositoryPreview("/project/web", []),
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  await expect.element(screen.getByText("No changes in any repository.")).toBeVisible();
  expect(screen.getByRole("button", { name: /Collapse api/ }).elements()).toHaveLength(0);
});

it("shows an unreadable repository in its place with a retry", async () => {
  const broken: RepositoryChoice = {
    key: "broken",
    root: "/project/broken",
    name: "broken",
    branch: null,
    detached: false,
    error: "permission denied",
  };
  using context = multiRepositorySetup([apiRepository, broken], {
    previews: {
      "/project/api": repositoryPreview("/project/api", [
        { path: "api.ts", additions: 3, deletions: 1 },
      ]),
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  await expect
    .element(
      screen.getByText("Could not read broken: /project/broken — permission denied", {
        exact: true,
      }),
    )
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(state.repositoryRefreshCount).toBeGreaterThan(0);
});

it("keeps a long repository name readable while its branch truncates first", async () => {
  const longName = "repository-with-a-long-but-readable-name";
  const longBranch = `feature/${"very-long-branch-name-".repeat(10)}end`;
  const longRepository: RepositoryChoice = {
    key: "long",
    root: "/project/long",
    name: longName,
    branch: longBranch,
    detached: false,
  };
  using context = multiRepositorySetup([apiRepository, longRepository], {
    previews: {
      "/project/api": repositoryPreview("/project/api", [
        { path: "api.ts", additions: 3, deletions: 1 },
      ]),
      "/project/long": repositoryPreview("/project/long", [
        { path: "src/long.ts", additions: 1, deletions: 0 },
      ]),
    },
    statuses: {
      "/project/long": { ...repositoryStatus("/project/long", []), refName: longBranch },
    },
  });
  await using screen = await renderEmbedded(context.registry, context.threadRef);
  const name = screen.getByText(longName, { exact: true }).element();
  expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth + 1);
  const branch = screen.container.querySelector<HTMLElement>(`[title="${longBranch}"]`);
  expect(branch).not.toBeNull();
  expect(branch!.querySelector("[data-overflow]")).not.toBeNull();
});

type ChangesCaptureCase =
  | "several-repositories"
  | "long-repository-and-branch"
  | "one-repository"
  | "empty"
  | "unreadable-repository"
  | "commits-needs-repository";

const CHANGES_CAPTURE_CASES: ReadonlyArray<ChangesCaptureCase> = [
  "several-repositories",
  "long-repository-and-branch",
  "one-repository",
  "empty",
  "unreadable-repository",
  "commits-needs-repository",
];

function changesCaptureContext(name: ChangesCaptureCase) {
  switch (name) {
    case "long-repository-and-branch": {
      const longName = "repository-with-a-long-but-readable-name";
      const longBranch = `feature/${"very-long-branch-name-".repeat(10)}end`;
      return multiRepositorySetup(
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
          previews: {
            "/project/api": repositoryPreview("/project/api", [
              { path: "src/api.ts", additions: 3, deletions: 1 },
            ]),
            "/project/long": repositoryPreview("/project/long", [
              { path: "src/long.ts", additions: 1, deletions: 0 },
            ]),
          },
          statuses: {
            "/project/long": { ...repositoryStatus("/project/long", []), refName: longBranch },
          },
        },
      );
    }
    case "one-repository":
      return multiRepositorySetup(
        [{ ...apiRepository, key: ".", root: "/project", name: "project" }],
        {
          previews: {
            "/project": repositoryPreview("/project", [
              { path: "src/api.ts", additions: 3, deletions: 1 },
            ]),
          },
        },
      );
    case "empty":
      return multiRepositorySetup([apiRepository, webRepository], {
        previews: {
          "/project/api": repositoryPreview("/project/api", []),
          "/project/web": repositoryPreview("/project/web", []),
        },
      });
    case "unreadable-repository":
      return multiRepositorySetup(
        [
          apiRepository,
          {
            key: "broken",
            root: "/project/broken",
            name: "broken",
            branch: null,
            detached: false,
            error: "permission denied",
          },
        ],
        {
          previews: {
            "/project/api": repositoryPreview("/project/api", [
              { path: "src/api.ts", additions: 3, deletions: 1 },
            ]),
          },
        },
      );
    case "commits-needs-repository": {
      const context = multiRepositorySetup([apiRepository, webRepository], {
        previews: {
          "/project/api": repositoryPreview("/project/api", []),
          "/project/web": repositoryPreview("/project/web", []),
        },
      });
      useDiffPanelStore.getState().selectCommit(context.threadRef, "abc1234");
      return context;
    }
    case "several-repositories":
      return multiRepositorySetup([apiRepository, webRepository], {
        previews: {
          "/project/api": repositoryPreview("/project/api", [
            { path: "src/api.ts", additions: 3, deletions: 1 },
            { path: "src/routes.ts", additions: 12, deletions: 4 },
          ]),
          "/project/web": repositoryPreview("/project/web", [
            { path: "src/web.ts", additions: 2, deletions: 0 },
          ]),
        },
      });
  }
}

describe.skipIf(!captureDir)("changes captures", () => {
  it.each(CHANGES_CAPTURE_CASES)("captures %s in both themes and widths", async (name) => {
    for (const theme of ["light", "dark"] as const) {
      state.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      for (const width of [390, 1280] as const) {
        const context = changesCaptureContext(name);
        const container = document.createElement("div");
        container.style.width = `${width}px`;
        const screen = await renderScreen(panel(context.registry, context.threadRef, "embedded"), {
          container,
        });
        try {
          await page.viewport(width, 800);
          await page.screenshot({
            element: screen.container,
            path: `${captureDir}/changes/${name}-${theme}-${width}.png`,
          });
        } finally {
          await screen[Symbol.asyncDispose]();
          context[Symbol.dispose]();
        }
      }
    }
    document.documentElement.classList.remove("dark");
    state.theme = "dark";
  });
});
