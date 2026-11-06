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
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: () => state.patch,
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
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
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
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
  };
  reset();
  state.diffFilesCollapsed = false;
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
  await expect.element(screen.getByRole("button", { name: "Add diff comment" })).toBeInTheDocument();
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
