import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsStageFilesInput,
  type VcsUnstageFilesInput,
  type VcsDiscardFilesInput,
  type VcsAmendCommitInput,
  type VcsAmendCommitResult,
  type VcsFetchInput,
  type VcsFetchResult,
  type VcsRenameRefInput,
  type VcsRenameRefResult,
  type VcsDeleteRefInput,
  type VcsListWorktreesResult,
  type VcsPruneWorktreesResult,
  type VcsListStashesResult,
  type VcsPushStashInput,
  type VcsPushStashResult,
  type VcsStashRefInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@houston-app/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

const HAS_REF_NAMED_PATTERN = /[*?[\\]/;
const BRANCH_REF_PREFIX = /^refs\/heads\//;

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly isRepository: (cwd: string) => Effect.Effect<boolean, GitManagerServiceError>;
    readonly hasCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly hasRefNamed: (input: {
      readonly cwd: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly status: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly currentBranch: (cwd: string) => Effect.Effect<string | null, GitManagerServiceError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: GitManager.GitRemoteStatusOptions,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly stageFiles: (
      input: VcsStageFilesInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly unstageFiles: (
      input: VcsUnstageFilesInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly discardFiles: (
      input: VcsDiscardFilesInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly amendCommit: (
      input: VcsAmendCommitInput,
    ) => Effect.Effect<VcsAmendCommitResult, GitManagerServiceError>;
    readonly fetchCurrentBranch: (
      input: VcsFetchInput,
    ) => Effect.Effect<VcsFetchResult, GitManagerServiceError>;
    readonly renameRef: (
      input: VcsRenameRefInput,
    ) => Effect.Effect<VcsRenameRefResult, GitManagerServiceError>;
    readonly deleteRef: (input: VcsDeleteRefInput) => Effect.Effect<void, GitManagerServiceError>;
    readonly listWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<VcsListWorktreesResult, GitCommandError>;
    readonly pruneWorktreesAndList: (input: {
      readonly cwd: string;
    }) => Effect.Effect<VcsPruneWorktreesResult, GitCommandError>;
    readonly listStashes: (input: {
      readonly cwd: string;
    }) => Effect.Effect<VcsListStashesResult, GitCommandError>;
    readonly pushStash: (
      input: VcsPushStashInput,
    ) => Effect.Effect<VcsPushStashResult, GitManagerServiceError>;
    readonly popStash: (input: VcsStashRefInput) => Effect.Effect<void, GitManagerServiceError>;
    readonly dropStash: (input: VcsStashRefInput) => Effect.Effect<void, GitManagerServiceError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitManager.GitRunStackedActionOptions,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly fetchRemote: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName?: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (input: {
      readonly cwd: string;
      readonly remoteName: string;
      readonly refName: string;
    }) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly fallbackRemoteName: string;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string },
      GitCommandError
    >;
    readonly resolveWorktreeBaseRemote: GitVcsDriver.GitVcsDriver["Service"]["resolveWorktreeBaseRemote"];
    readonly fetchWorktreeBaseCommit: (input: {
      readonly cwd: string;
      readonly refName: string;
      readonly remote?: GitVcsDriver.GitWorktreeBaseRemote;
    }) => Effect.Effect<
      { readonly commitSha: string; readonly remoteRefName: string } | null,
      GitCommandError
    >;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitVcsDriver.GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly exactName?: boolean;
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
  }
>()("@houston-app/cli/git/GitWorkflowService") {}

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const fileSystem = yield* FileSystem.FileSystem;

  // Nested projects and path aliases must share the checkout's branch-mutation lease.
  const withCheckoutLease = <A, E, R>(rootPath: string, effect: Effect.Effect<A, E, R>) =>
    fileSystem.realPath(rootPath).pipe(
      Effect.orElseSucceed(() => rootPath),
      Effect.flatMap((cwd) => withWorkspaceLease(cwd, effect)),
    );

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitManagerError({
            operation,
            cwd,
            detail: "Failed to resolve the VCS driver for this Git workflow.",
            cause,
          }),
      ),
    );
    return handle;
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry.resolve({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to resolve the VCS driver for this Git command.",
            cause,
          }),
      ),
    );
    return handle;
  });

  // Git work runs only inside a registered workspace; these RPCs take the cwd from the client.
  const ensureKnownWorkspace = (operation: string, cwd: string) =>
    knownWorkspaces.assertContains(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "git",
            cwd,
            detail: `Refusing ${operation}: ${cause.message}`,
          }),
      ),
    );

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry.detect({ cwd }).pipe(
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation,
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
      if (!handle) {
        return false;
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry.detect({ cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "vcs-route",
            cwd,
            detail: "Failed to detect a VCS repository for this Git command.",
            cause,
          }),
      ),
    );
    if (!handle) {
      return false;
    }
    return true;
  });

  return GitWorkflowService.of({
    isRepository: Effect.fn("GitWorkflowService.isRepository")(function (cwd) {
      return registry.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.kind === "git"),
        Effect.mapError(
          (cause) =>
            new GitManagerError({
              operation: "GitWorkflowService.isRepository",
              cwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause,
            }),
        ),
      );
    }),
    hasCommit: Effect.fn("GitWorkflowService.hasCommit")(function (input) {
      return ensureGitCommand("GitWorkflowService.hasCommit", input.cwd).pipe(
        Effect.andThen(
          git.execute({
            operation: "GitWorkflowService.hasCommit",
            cwd: input.cwd,
            args: ["rev-parse", "--verify", `${input.refName}^{commit}`],
            allowNonZeroExit: true,
          }),
        ),
        Effect.map((result) => result.exitCode === 0),
      );
    }),
    hasRefNamed: Effect.fn("GitWorkflowService.hasRefNamed")(function (input) {
      // Pattern characters would widen the ref match.
      return HAS_REF_NAMED_PATTERN.test(input.refName)
        ? Effect.succeed(false)
        : ensureGitCommand("GitWorkflowService.hasRefNamed", input.cwd).pipe(
            Effect.andThen(
              git.execute({
                operation: "GitWorkflowService.hasRefNamed",
                cwd: input.cwd,
                args: [
                  "for-each-ref",
                  "--count=1",
                  "--format=%(refname)",
                  `refs/**/${input.refName}`,
                ],
              }),
            ),
            Effect.map((result) => result.stdout.trim().length > 0),
          );
    }),
    status: Effect.fn("GitWorkflowService.status")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.status(input) : Effect.succeed(nonRepositoryStatus()),
        ),
      );
    }),
    localStatus: Effect.fn("GitWorkflowService.localStatus")(function (input) {
      return detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.localStatus(input)
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      );
    }),
    currentBranch: Effect.fn("GitWorkflowService.currentBranch")(function* (cwd) {
      if (!(yield* detectGitRepositoryForStatus("GitWorkflowService.currentBranch", cwd))) {
        return null;
      }
      const result = yield* git.execute({
        operation: "GitWorkflowService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) {
        return result.stdout.trim().replace(BRANCH_REF_PREFIX, "") || null;
      }
      if (result.exitCode === 1) return null;
      return yield* new GitCommandError({
        operation: "GitWorkflowService.currentBranch",
        command: "git symbolic-ref",
        cwd,
        argumentCount: 3,
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        detail: "Failed to read the checked-out branch.",
      });
    }),
    remoteStatus: Effect.fn("GitWorkflowService.remoteStatus")(function (input, options) {
      return detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository ? gitManager.remoteStatus(input, options) : Effect.succeed(null),
        ),
      );
    }),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: Effect.fn("GitWorkflowService.pullCurrentBranch")(function (cwd) {
      return ensureKnownWorkspace("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
            Effect.andThen(git.pullCurrentBranch(cwd)),
          ),
        ),
      );
    }),
    stageFiles: Effect.fn("GitWorkflowService.stageFiles")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.stageFiles", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.stageFiles", input.cwd).pipe(
            Effect.andThen(git.stageFiles(input.cwd, input.filePaths)),
            Effect.andThen(gitManager.invalidateLocalStatus(input.cwd)),
            Effect.andThen(gitManager.localStatus({ cwd: input.cwd })),
          ),
        ),
      );
    }),
    unstageFiles: Effect.fn("GitWorkflowService.unstageFiles")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.unstageFiles", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.unstageFiles", input.cwd).pipe(
            Effect.andThen(git.unstageFiles(input.cwd, input.filePaths)),
            Effect.andThen(gitManager.invalidateLocalStatus(input.cwd)),
            Effect.andThen(gitManager.localStatus({ cwd: input.cwd })),
          ),
        ),
      );
    }),
    discardFiles: Effect.fn("GitWorkflowService.discardFiles")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.discardFiles", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.discardFiles", input.cwd).pipe(
            Effect.andThen(git.discardFiles(input.cwd, input.files)),
            Effect.andThen(gitManager.invalidateLocalStatus(input.cwd)),
            Effect.andThen(gitManager.localStatus({ cwd: input.cwd })),
          ),
        ),
      );
    }),
    amendCommit: Effect.fn("GitWorkflowService.amendCommit")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.amendCommit", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.amendCommit", input.cwd).pipe(
            Effect.andThen(git.amendCommit(input.cwd, input.message)),
            Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
          ),
        ),
      );
    }),
    fetchCurrentBranch: Effect.fn("GitWorkflowService.fetchCurrentBranch")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.fetchCurrentBranch", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.fetchCurrentBranch", input.cwd).pipe(
            Effect.andThen(git.fetchCurrentBranch(input.cwd)),
            Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
          ),
        ),
      );
    }),
    renameRef: Effect.fn("GitWorkflowService.renameRef")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.renameRef", input.cwd).pipe(
        Effect.andThen(ensureGit("GitWorkflowService.renameRef", input.cwd)),
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            git.renameBranch({
              cwd: input.cwd,
              oldBranch: input.oldRefName,
              newBranch: input.newRefName,
              exactName: true,
            }),
          ),
        ),
        Effect.map((result) => ({ refName: result.branch })),
      );
    }),
    deleteRef: Effect.fn("GitWorkflowService.deleteRef")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.deleteRef", input.cwd).pipe(
        Effect.andThen(ensureGit("GitWorkflowService.deleteRef", input.cwd)),
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            git.deleteLocalBranch({
              cwd: input.cwd,
              refName: input.refName,
              ...(input.force === true ? { force: true } : {}),
            }),
          ),
        ),
      );
    }),
    listWorktrees: Effect.fn("GitWorkflowService.listWorktrees")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.listWorktrees", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.listWorktrees", input.cwd).pipe(
            Effect.andThen(git.listWorktrees(input.cwd)),
          ),
        ),
      );
    }),
    pruneWorktreesAndList: Effect.fn("GitWorkflowService.pruneWorktreesAndList")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.pruneWorktreesAndList", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.pruneWorktreesAndList", input.cwd).pipe(
            Effect.andThen(git.pruneWorktrees(input)),
            Effect.andThen(git.listWorktrees(input.cwd)),
          ),
        ),
      );
    }),
    listStashes: Effect.fn("GitWorkflowService.listStashes")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.listStashes", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.listStashes", input.cwd).pipe(
            Effect.andThen(git.listStashes(input.cwd)),
          ),
        ),
      );
    }),
    pushStash: Effect.fn("GitWorkflowService.pushStash")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.pushStash", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.pushStash", input.cwd).pipe(
            Effect.andThen(git.pushStash(input.cwd, input.message)),
            Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
          ),
        ),
      );
    }),
    popStash: Effect.fn("GitWorkflowService.popStash")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.popStash", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.popStash", input.cwd).pipe(
            Effect.andThen(git.popStash(input.cwd, input.ref)),
            Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
          ),
        ),
      );
    }),
    dropStash: Effect.fn("GitWorkflowService.dropStash")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.dropStash", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.dropStash", input.cwd).pipe(
            Effect.andThen(git.dropStash(input.cwd, input.ref)),
            Effect.tap(() => gitManager.invalidateStatus(input.cwd)),
          ),
        ),
      );
    }),
    runStackedAction: Effect.fn("GitWorkflowService.runStackedAction")(function (input, options) {
      return ensureKnownWorkspace("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(ensureGit("GitWorkflowService.runStackedAction", input.cwd)),
        Effect.flatMap((handle) =>
          withCheckoutLease(
            handle.repository.rootPath,
            gitManager.runStackedAction(input, options),
          ),
        ),
      );
    }),
    resolvePullRequest: Effect.fn("GitWorkflowService.resolvePullRequest")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.resolvePullRequest", input.cwd).pipe(
        Effect.andThen(ensureGit("GitWorkflowService.resolvePullRequest", input.cwd)),
        Effect.andThen(gitManager.resolvePullRequest(input)),
      );
    }),
    preparePullRequestThread: Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function (input) {
        return ensureKnownWorkspace("GitWorkflowService.preparePullRequestThread", input.cwd).pipe(
          Effect.andThen(ensureGit("GitWorkflowService.preparePullRequestThread", input.cwd)),
          Effect.flatMap((handle) =>
            input.mode === "local"
              ? withCheckoutLease(
                  handle.repository.rootPath,
                  gitManager.preparePullRequestThread(input),
                )
              : gitManager.preparePullRequestThread(input),
          ),
        );
      },
    ),
    listRefs: Effect.fn("GitWorkflowService.listRefs")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.andThen(
          detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
            Effect.flatMap((isGitRepository) =>
              isGitRepository ? git.listRefs(input) : Effect.succeed(nonRepositoryListRefs()),
            ),
          ),
        ),
      );
    }),
    createWorktree: Effect.fn("GitWorkflowService.createWorktree")(function (input, options) {
      return ensureKnownWorkspace("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
            Effect.andThen(gitManager.createWorktree(input, options)),
          ),
        ),
      );
    }),
    listLocalBranchNames: Effect.fn("GitWorkflowService.listLocalBranchNames")(function (cwd) {
      return ensureGitCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.andThen(git.listLocalBranchNames(cwd)),
      );
    }),
    fetchRemote: Effect.fn("GitWorkflowService.fetchRemote")(function (input) {
      return ensureGitCommand("GitWorkflowService.fetchRemote", input.cwd).pipe(
        Effect.andThen(git.fetchRemote(input)),
      );
    }),
    remoteExists: Effect.fn("GitWorkflowService.remoteExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteExists", input.cwd).pipe(
        Effect.andThen(git.remoteExists(input)),
      );
    }),
    remoteBranchExists: Effect.fn("GitWorkflowService.remoteBranchExists")(function (input) {
      return ensureGitCommand("GitWorkflowService.remoteBranchExists", input.cwd).pipe(
        Effect.andThen(git.remoteBranchExists(input)),
      );
    }),
    resolveRemoteTrackingCommit: Effect.fn("GitWorkflowService.resolveRemoteTrackingCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveRemoteTrackingCommit", input.cwd).pipe(
          Effect.andThen(git.resolveRemoteTrackingCommit(input)),
        );
      },
    ),
    resolveWorktreeBaseRemote: Effect.fn("GitWorkflowService.resolveWorktreeBaseRemote")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.resolveWorktreeBaseRemote", input.cwd).pipe(
          Effect.andThen(git.resolveWorktreeBaseRemote(input)),
        );
      },
    ),
    fetchWorktreeBaseCommit: Effect.fn("GitWorkflowService.fetchWorktreeBaseCommit")(
      function (input) {
        return ensureGitCommand("GitWorkflowService.fetchWorktreeBaseCommit", input.cwd).pipe(
          Effect.andThen(git.fetchWorktreeBaseCommit(input)),
        );
      },
    ),
    removeWorktree: Effect.fn("GitWorkflowService.removeWorktree")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(
          ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
            Effect.andThen(git.removeWorktree(input)),
          ),
        ),
      );
    }),
    pruneWorktrees: Effect.fn("GitWorkflowService.pruneWorktrees")(function (input) {
      return ensureGitCommand("GitWorkflowService.pruneWorktrees", input.cwd).pipe(
        Effect.andThen(git.pruneWorktrees(input)),
      );
    }),
    deleteLocalBranch: Effect.fn("GitWorkflowService.deleteLocalBranch")(function (input) {
      return ensureGitCommand("GitWorkflowService.deleteLocalBranch", input.cwd).pipe(
        Effect.andThen(git.deleteLocalBranch(input)),
      );
    }),
    createRef: Effect.fn("GitWorkflowService.createRef")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(ensureGitCommand("GitWorkflowService.createRef", input.cwd)),
        Effect.flatMap((handle) =>
          input.switchRef
            ? withCheckoutLease(handle.repository.rootPath, git.createRef(input))
            : git.createRef(input),
        ),
      );
    }),
    switchRef: Effect.fn("GitWorkflowService.switchRef")(function (input) {
      return ensureKnownWorkspace("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(ensureGitCommand("GitWorkflowService.switchRef", input.cwd)),
        Effect.flatMap((handle) =>
          withCheckoutLease(handle.repository.rootPath, Effect.scoped(git.switchRef(input))),
        ),
      );
    }),
    renameBranch: Effect.fn("GitWorkflowService.renameBranch")(function (input) {
      return ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      );
    }),
  });
});

export const layer = Layer.effect(GitWorkflowService, make);
