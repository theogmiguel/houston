import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  GitRunStackedActionResult,
  GitResolvedPullRequest,
  GitStackedAction,
  VcsPullResult,
} from "@houston-app/contracts";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

type RefusalError = {
  readonly _tag: string;
  readonly detail?: string;
};

const resolvedPullRequest = (): GitResolvedPullRequest => ({
  number: 1,
  title: "Test pull request",
  url: "https://example.test/pull/1",
  baseBranch: "main",
  headBranch: "topic",
  state: "open",
});

const pullResult = (): VcsPullResult => ({
  status: "pulled",
  refName: "main",
  upstreamRef: "origin/main",
});

const stackedActionResult = (action: GitStackedAction): GitRunStackedActionResult => ({
  action,
  branch: { status: "skipped_not_requested" },
  commit: { status: "created", commitSha: "0".repeat(40), subject: "Test commit" },
  push: { status: "skipped_not_requested" },
  pr: { status: "skipped_not_requested" },
  toast: { title: "Committed", cta: { kind: "none" } },
});

interface WorkflowMockOptions {
  readonly known: boolean;
  readonly calls: string[];
}

const makeWorkflowLayer = (options: WorkflowMockOptions) => {
  const record = (call: string) => Effect.sync(() => options.calls.push(call));
  const handle = (cwd: string) =>
    ({
      kind: "git",
      repository: { rootPath: cwd },
    }) as unknown as VcsDriverRegistry.VcsDriverHandle;
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: ({ cwd }) => record(`detect:${cwd}`).pipe(Effect.as(handle(cwd))),
        resolve: ({ cwd }) => record(`resolve:${cwd}`).pipe(Effect.as(handle(cwd))),
      }),
    ),
    Layer.provide(
      Layer.mock(GitManager.GitManager)({
        runStackedAction: (input) =>
          record("manager.runStackedAction").pipe(Effect.as(stackedActionResult(input.action))),
        resolvePullRequest: () =>
          record("manager.resolvePullRequest").pipe(
            Effect.as({ pullRequest: resolvedPullRequest() }),
          ),
        preparePullRequestThread: () =>
          record("manager.preparePullRequestThread").pipe(
            Effect.as({
              pullRequest: resolvedPullRequest(),
              branch: "topic",
              worktreePath: null,
              isOnPullRequestHead: true,
            }),
          ),
        createWorktree: () =>
          record("manager.createWorktree").pipe(
            Effect.as({ worktree: { path: "/tmp/houston-worktree", refName: "topic" } }),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        pullCurrentBranch: (cwd) =>
          record(`git.pullCurrentBranch:${cwd}`).pipe(Effect.as(pullResult())),
        listRefs: (input) =>
          record(`git.listRefs:${input.cwd}`).pipe(
            Effect.as({
              refs: [],
              isRepo: true,
              hasPrimaryRemote: false,
              nextCursor: null,
              totalCount: 0,
            }),
          ),
        createRef: (input) =>
          record(`git.createRef:${input.cwd}`).pipe(Effect.as({ refName: input.refName })),
        switchRef: (input) =>
          record(`git.switchRef:${input.cwd}`).pipe(Effect.as({ refName: input.refName })),
        removeWorktree: (input) => record(`git.removeWorktree:${input.cwd}`).pipe(Effect.asVoid),
      }),
    ),
    Layer.provide(
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({
        assertContains: (cwd) =>
          record(`assertContains:${cwd}`).pipe(
            Effect.andThen(
              options.known
                ? Effect.void
                : Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
            ),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "houston-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "houston/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
          ),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "houston-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("refuses a working-tree action outside the known workspaces", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "houston-outside-workspace-",
      });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const failure = yield* workflow
        .stageFiles({ cwd: outside, filePaths: ["a.txt"] })
        .pipe(Effect.flip);
      assert.strictEqual(failure._tag, "GitCommandError");
      if (failure._tag !== "GitCommandError") {
        return yield* Effect.die(`Unexpected failure: ${failure._tag}`);
      }
      assert.include(failure.detail, outside);
      assert.include(failure.detail, "not a registered project");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(KnownWorkspaces.KnownWorkspaces)({
              assertContains: (cwd) =>
                Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd })),
            }),
          ),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "houston-outside-workspace-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("refuses every cwd-taking Git RPC outside the known workspaces", () => {
    const outside = "/tmp/houston-outside-workspace";
    const calls: string[] = [];
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const attempts: ReadonlyArray<readonly [string, Effect.Effect<unknown, RefusalError>]> = [
        ["pullCurrentBranch", workflow.pullCurrentBranch(outside)],
        [
          "runStackedAction",
          workflow.runStackedAction({ cwd: outside, actionId: "a", action: "commit" }),
        ],
        ["resolvePullRequest", workflow.resolvePullRequest({ cwd: outside, reference: "1" })],
        [
          "preparePullRequestThread",
          workflow.preparePullRequestThread({ cwd: outside, reference: "1", mode: "local" }),
        ],
        ["listRefs", workflow.listRefs({ cwd: outside })],
        ["createWorktree", workflow.createWorktree({ cwd: outside, refName: "main", path: null })],
        ["removeWorktree", workflow.removeWorktree({ cwd: outside, path: `${outside}/worktree` })],
        ["createRef", workflow.createRef({ cwd: outside, refName: "topic" })],
        ["switchRef", workflow.switchRef({ cwd: outside, refName: "main" })],
      ];
      for (const [name, attempt] of attempts) {
        const outcome = yield* attempt.pipe(
          Effect.match({
            onFailure: (error) => ({ refused: true as const, error }),
            onSuccess: (value) => ({ refused: false as const, value }),
          }),
        );
        assert.isTrue(outcome.refused, `${name} must refuse a cwd outside every workspace`);
        if (!outcome.refused) continue;
        assert.strictEqual(outcome.error._tag, "GitCommandError", name);
        assert.include(outcome.error.detail ?? "", "not a registered project", name);
      }
      assert.deepEqual(
        calls,
        attempts.map(() => `assertContains:${outside}`),
        "no Git command may run outside a known workspace",
      );
    }).pipe(Effect.provide(makeWorkflowLayer({ known: false, calls })));
  });

  it.effect("runs every cwd-taking Git RPC inside a known workspace", () => {
    const cwd = "/tmp/houston-known-workspace";
    const calls: string[] = [];
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const actions: ReadonlyArray<readonly [string, Effect.Effect<unknown, RefusalError>]> = [
        ["pullCurrentBranch", workflow.pullCurrentBranch(cwd)],
        ["runStackedAction", workflow.runStackedAction({ cwd, actionId: "a", action: "commit" })],
        ["resolvePullRequest", workflow.resolvePullRequest({ cwd, reference: "1" })],
        [
          "preparePullRequestThread",
          workflow.preparePullRequestThread({ cwd, reference: "1", mode: "local" }),
        ],
        ["listRefs", workflow.listRefs({ cwd })],
        ["createWorktree", workflow.createWorktree({ cwd, refName: "main", path: null })],
        ["removeWorktree", workflow.removeWorktree({ cwd, path: `${cwd}/worktree` })],
        ["createRef", workflow.createRef({ cwd, refName: "topic" })],
        ["switchRef", workflow.switchRef({ cwd, refName: "main" })],
      ];
      for (const [name, action] of actions) {
        calls.length = 0;
        yield* action;
        assert.strictEqual(calls[0], `assertContains:${cwd}`, name);
        assert.isAbove(calls.length, 1, `${name} must reach Git inside a known workspace`);
      }
    }).pipe(Effect.provide(makeWorkflowLayer({ known: true, calls })));
  });
});
