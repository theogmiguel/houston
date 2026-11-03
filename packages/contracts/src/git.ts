import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ForwardCompatibleOptional,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderError, SourceControlProviderInfo } from "./sourceControl.ts";
import { VcsDriverKind } from "./vcs.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const GitFilePath = Schema.String.check(Schema.isNonEmpty());
const GIT_LIST_BRANCHES_MAX_LIMIT = 200;
// A working-tree action names the files it changes; one press must not sweep the whole tree.
const GIT_FILE_MUTATION_MAX_PATHS = 500;

export const GitStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type GitStackedAction = typeof GitStackedAction.Type;
export const GitActionProgressPhase = Schema.Literals(["branch", "commit", "push", "pr"]);
export type GitActionProgressPhase = typeof GitActionProgressPhase.Type;
export const GitActionProgressKind = Schema.Literals([
  "action_started",
  "phase_started",
  "hook_started",
  "hook_output",
  "hook_finished",
  "action_finished",
  "action_failed",
]);
export type GitActionProgressKind = typeof GitActionProgressKind.Type;
export const GitActionProgressStream = Schema.Literals(["stdout", "stderr"]);
export type GitActionProgressStream = typeof GitActionProgressStream.Type;
const GitCommitStepStatus = Schema.Literals([
  "created",
  "skipped_no_changes",
  "skipped_not_requested",
]);
const GitPushStepStatus = Schema.Literals([
  "pushed",
  "skipped_not_requested",
  "skipped_up_to_date",
]);
const GitBranchStepStatus = Schema.Literals(["created", "skipped_not_requested"]);
const GitPrStepStatus = Schema.Literals(["created", "opened_existing", "skipped_not_requested"]);
const VcsStatusChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPullRequestReference = TrimmedNonEmptyStringSchema;
const GitPullRequestState = Schema.Literals(["open", "closed", "merged"]);
const GitPreparePullRequestThreadMode = Schema.Literals(["local", "worktree"]);
export const GitRunStackedActionToastRunAction = Schema.Struct({
  kind: GitStackedAction,
});
export type GitRunStackedActionToastRunAction = typeof GitRunStackedActionToastRunAction.Type;
const GitRunStackedActionToastCta = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none"),
  }),
  Schema.Struct({
    kind: Schema.Literal("open_pr"),
    label: TrimmedNonEmptyStringSchema,
    url: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_action"),
    label: TrimmedNonEmptyStringSchema,
    action: GitRunStackedActionToastRunAction,
  }),
]);
export type GitRunStackedActionToastCta = typeof GitRunStackedActionToastCta.Type;
const GitRunStackedActionToast = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  cta: GitRunStackedActionToastCta,
});
export type GitRunStackedActionToast = typeof GitRunStackedActionToast.Type;

export const VcsRef = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  isRemote: Schema.optional(Schema.Boolean),
  remoteName: Schema.optional(TrimmedNonEmptyStringSchema),
  // Full Git ref, for example refs/remotes/origin/feature.
  upstreamRef: Schema.optional(TrimmedNonEmptyStringSchema),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsRef = typeof VcsRef.Type;

const VcsWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
const GitResolvedPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyStringSchema,
  headBranch: TrimmedNonEmptyStringSchema,
  state: GitPullRequestState,
});
export type GitResolvedPullRequest = typeof GitResolvedPullRequest.Type;

export const VcsStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsStatusSubscriptionInput = Schema.Struct({
  ...VcsStatusInput.fields,
  /** Passive observers receive cached remote status without retaining its refresh loop. */
  includeRemote: Schema.optional(Schema.Boolean),
});
export type VcsStatusSubscriptionInput = typeof VcsStatusSubscriptionInput.Type;

export const VcsPullInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPullInput = typeof VcsPullInput.Type;

export const VcsStageFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  filePaths: Schema.Array(GitFilePath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(GIT_FILE_MUTATION_MAX_PATHS),
  ),
});
export type VcsStageFilesInput = typeof VcsStageFilesInput.Type;

export const VcsUnstageFilesInput = VcsStageFilesInput;
export type VcsUnstageFilesInput = typeof VcsUnstageFilesInput.Type;

export const VcsDiscardKind = Schema.Literals(["staged", "unstaged", "untracked"]);
export type VcsDiscardKind = typeof VcsDiscardKind.Type;

export const VcsDiscardFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  files: Schema.Array(
    Schema.Struct({
      path: GitFilePath,
      kind: VcsDiscardKind,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(GIT_FILE_MUTATION_MAX_PATHS)),
});
export type VcsDiscardFilesInput = typeof VcsDiscardFilesInput.Type;

export const VcsAmendCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000)),
});
export type VcsAmendCommitInput = typeof VcsAmendCommitInput.Type;

export const VcsAmendCommitResult = Schema.Struct({
  commitSha: TrimmedNonEmptyStringSchema,
});
export type VcsAmendCommitResult = typeof VcsAmendCommitResult.Type;

export const VcsFetchInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsFetchInput = typeof VcsFetchInput.Type;

export const VcsFetchResult = Schema.Struct({
  remoteName: TrimmedNonEmptyStringSchema,
  /** The first non-empty line git printed, for the toast under the button. */
  summary: TrimmedNonEmptyStringSchema,
});
export type VcsFetchResult = typeof VcsFetchResult.Type;

export const GitRunStackedActionInput = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
  commitMessage: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(10_000))),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(Schema.Array(GitFilePath).check(Schema.isMinLength(1))),
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
});
export type GitRunStackedActionInput = typeof GitRunStackedActionInput.Type;

export const VcsListRefsInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  query: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt),
  includeMatchingRemoteRefs: Schema.optional(Schema.Boolean),
  refKind: Schema.optional(Schema.Literals(["all", "local", "remote"])),
  refresh: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(GIT_LIST_BRANCHES_MAX_LIMIT)),
  ),
});
export type VcsListRefsInput = typeof VcsListRefsInput.Type;

export const VcsCreateWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  newRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  baseRefName: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsCreateWorktreeInput = typeof VcsCreateWorktreeInput.Type;

export const GitPullRequestRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
});
export type GitPullRequestRefInput = typeof GitPullRequestRefInput.Type;

export const GitPreparePullRequestThreadInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  reference: GitPullRequestReference,
  mode: GitPreparePullRequestThreadMode,
  threadId: Schema.optional(ThreadId),
});
export type GitPreparePullRequestThreadInput = typeof GitPreparePullRequestThreadInput.Type;

export const VcsRemoveWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});
export type VcsRemoveWorktreeInput = typeof VcsRemoveWorktreeInput.Type;

export const VcsCreateRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  switchRef: Schema.optional(Schema.Boolean),
});
export type VcsCreateRefInput = typeof VcsCreateRefInput.Type;

export const VcsCreateRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsCreateRefResult = typeof VcsCreateRefResult.Type;

export const VcsSwitchRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsSwitchRefInput = typeof VcsSwitchRefInput.Type;

export const VcsRenameRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  oldRefName: TrimmedNonEmptyStringSchema,
  newRefName: TrimmedNonEmptyStringSchema,
});
export type VcsRenameRefInput = typeof VcsRenameRefInput.Type;

export const VcsRenameRefResult = Schema.Struct({
  refName: TrimmedNonEmptyStringSchema,
});
export type VcsRenameRefResult = typeof VcsRenameRefResult.Type;

export const VcsDeleteRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  /** Force deletes a branch whose work is not merged. The UI asks first. */
  force: Schema.optional(Schema.Boolean),
});
export type VcsDeleteRefInput = typeof VcsDeleteRefInput.Type;

export const VcsListWorktreesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsListWorktreesInput = typeof VcsListWorktreesInput.Type;

export const VcsWorktreeInfo = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  headSha: Schema.NullOr(TrimmedNonEmptyStringSchema),
  isMain: Schema.Boolean,
  isBare: Schema.Boolean,
  isDetached: Schema.Boolean,
  /** Present when git reports the worktree locked; the value is git's reason or "". */
  locked: Schema.optional(Schema.NullOr(Schema.String)),
  /** Present when git reports the directory missing or unusable. */
  prunable: Schema.optional(Schema.NullOr(Schema.String)),
});
export type VcsWorktreeInfo = typeof VcsWorktreeInfo.Type;

export const VcsListWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(VcsWorktreeInfo),
});
export type VcsListWorktreesResult = typeof VcsListWorktreesResult.Type;

export const VcsPruneWorktreesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsPruneWorktreesInput = typeof VcsPruneWorktreesInput.Type;

export const VcsPruneWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(VcsWorktreeInfo),
});
export type VcsPruneWorktreesResult = typeof VcsPruneWorktreesResult.Type;

export const VcsStashEntry = Schema.Struct({
  ref: TrimmedNonEmptyStringSchema,
  message: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
});
export type VcsStashEntry = typeof VcsStashEntry.Type;

export const VcsListStashesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsListStashesInput = typeof VcsListStashesInput.Type;

export const VcsListStashesResult = Schema.Struct({
  stashes: Schema.Array(VcsStashEntry),
});
export type VcsListStashesResult = typeof VcsListStashesResult.Type;

export const VcsPushStashInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  message: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(1_000))),
});
export type VcsPushStashInput = typeof VcsPushStashInput.Type;

export const VcsPushStashResult = Schema.Struct({
  /** False when git found nothing to stash. */
  created: Schema.Boolean,
});
export type VcsPushStashResult = typeof VcsPushStashResult.Type;

export const VcsStashRefInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  ref: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^stash@\{\d+\}$/)),
});
export type VcsStashRefInput = typeof VcsStashRefInput.Type;

export const VcsInitInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  kind: Schema.optional(VcsDriverKind),
});
export type VcsInitInput = typeof VcsInitInput.Type;

const VcsStatusChangeRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyStringSchema,
  url: Schema.String,
  baseRef: TrimmedNonEmptyStringSchema,
  headRef: TrimmedNonEmptyStringSchema,
  state: VcsStatusChangeRequestState,
  isDraft: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export const VcsWorkingTreeFileStatus = Schema.Literals([
  "modified",
  "added",
  "untracked",
  "deleted",
  "renamed",
  "conflicted",
]);
export type VcsWorkingTreeFileStatus = typeof VcsWorkingTreeFileStatus.Type;

const VcsStatusLocalShape = {
  isRepo: Schema.Boolean,
  sourceControlProvider: Schema.optional(SourceControlProviderInfo),
  hasPrimaryRemote: Schema.Boolean,
  isDefaultRef: Schema.Boolean,
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  hasWorkingTreeChanges: Schema.Boolean,
  workingTree: Schema.Struct({
    // Absolute worktree root on the environment that every files[].path is
    // relative to. Absent when the server could not resolve it.
    rootPath: Schema.optional(GitFilePath),
    files: Schema.Array(
      Schema.Struct({
        path: GitFilePath,
        insertions: NonNegativeInt,
        deletions: NonNegativeInt,
        // Optional so a status from before these flags existed still decodes.
        staged: Schema.optional(Schema.Boolean),
        unstaged: Schema.optional(Schema.Boolean),
        untracked: Schema.optional(Schema.Boolean),
        conflicted: Schema.optional(Schema.Boolean),
        // Omitted by servers that do not classify working-tree changes.
        status: Schema.optional(VcsWorkingTreeFileStatus),
      }),
    ),
    insertions: NonNegativeInt,
    deletions: NonNegativeInt,
  }),
  branchChanges: Schema.optional(
    Schema.Struct({
      baseRef: Schema.NullOr(TrimmedNonEmptyStringSchema),
      insertions: NonNegativeInt,
      deletions: NonNegativeInt,
    }),
  ),
  // Present only while a merge, rebase or cherry-pick is paused in the checkout.
  pausedOperation: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["merge", "rebase", "cherry-pick"]),
      conflictedPaths: Schema.Array(GitFilePath),
    }),
  ),
};

const VcsStatusRemoteShape = {
  hasUpstream: Schema.Boolean,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
  aheadOfDefaultCount: Schema.optional(NonNegativeInt),
  pr: Schema.NullOr(VcsStatusChangeRequest),
};

export const VcsStatusLocalResult = Schema.Struct(VcsStatusLocalShape);
export type VcsStatusLocalResult = typeof VcsStatusLocalResult.Type;

export const VcsStatusRemoteResult = Schema.Struct(VcsStatusRemoteShape);
export type VcsStatusRemoteResult = typeof VcsStatusRemoteResult.Type;

export const VcsStatusResult = Schema.Struct({
  ...VcsStatusLocalShape,
  ...VcsStatusRemoteShape,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsStatusStreamEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    local: VcsStatusLocalResult,
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
  Schema.TaggedStruct("localUpdated", {
    local: VcsStatusLocalResult,
  }),
  Schema.TaggedStruct("remoteUpdated", {
    remote: Schema.NullOr(VcsStatusRemoteResult),
  }),
]);
export type VcsStatusStreamEvent = typeof VcsStatusStreamEvent.Type;

export const VcsListRefsResult = Schema.Struct({
  isAtRepositoryRoot: Schema.optional(Schema.Boolean),
  refs: Schema.Array(VcsRef),
  isRepo: Schema.Boolean,
  hasPrimaryRemote: Schema.Boolean,
  nextCursor: NonNegativeInt.pipe(Schema.NullOr),
  totalCount: NonNegativeInt,
});
export type VcsListRefsResult = typeof VcsListRefsResult.Type;

export const VcsCreateWorktreeResult = Schema.Struct({
  worktree: VcsWorktree,
});
export type VcsCreateWorktreeResult = typeof VcsCreateWorktreeResult.Type;

export const GitResolvePullRequestResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
});
export type GitResolvePullRequestResult = typeof GitResolvePullRequestResult.Type;

export const GitPreparePullRequestThreadResult = Schema.Struct({
  pullRequest: GitResolvedPullRequest,
  branch: TrimmedNonEmptyStringSchema,
  worktreePath: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
  /** False when local commits or edits prevented a reused worktree from reaching the PR head. */
  isOnPullRequestHead: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GitPreparePullRequestThreadResult = typeof GitPreparePullRequestThreadResult.Type;

export const VcsSwitchRefResult = Schema.Struct({
  refName: Schema.NullOr(TrimmedNonEmptyStringSchema),
});
export type VcsSwitchRefResult = typeof VcsSwitchRefResult.Type;

export const GitRunStackedActionResult = Schema.Struct({
  action: GitStackedAction,
  branch: Schema.Struct({
    status: GitBranchStepStatus,
    name: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  commit: Schema.Struct({
    status: GitCommitStepStatus,
    commitSha: Schema.optional(TrimmedNonEmptyStringSchema),
    subject: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  push: Schema.Struct({
    status: GitPushStepStatus,
    branch: Schema.optional(TrimmedNonEmptyStringSchema),
    upstreamBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    setUpstream: Schema.optional(Schema.Boolean),
  }),
  pr: Schema.Struct({
    status: GitPrStepStatus,
    url: Schema.optional(Schema.String),
    number: Schema.optional(PositiveInt),
    baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    headBranch: Schema.optional(TrimmedNonEmptyStringSchema),
    title: Schema.optional(TrimmedNonEmptyStringSchema),
  }),
  toast: GitRunStackedActionToast,
});
export type GitRunStackedActionResult = typeof GitRunStackedActionResult.Type;

export const VcsPullResult = Schema.Struct({
  status: Schema.Literals(["pulled", "skipped_up_to_date"]),
  refName: TrimmedNonEmptyStringSchema,
  upstreamRef: TrimmedNonEmptyStringSchema.pipe(Schema.NullOr),
});
export type VcsPullResult = typeof VcsPullResult.Type;

// Git stderr can echo credentials from argv and remote URLs. Only a fixed
// reason reaches the error and its diagnostic suffix; newer, unknown reasons
// decode as absent through GitCommandError.
export const GitCommandFailureReason = Schema.Literals([
  "authentication_failed",
  "branch_already_exists",
  "branch_checked_out_in_worktree",
  "config_locked",
  "host_key_unverified",
  "not_a_repository",
  "path_already_exists",
  "push_rejected_by_remote",
  "push_rejected_non_fast_forward",
  "ref_not_found",
  "remote_unreachable",
  "tag_would_be_clobbered",
]);
export type GitCommandFailureReason = typeof GitCommandFailureReason.Type;

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  stdoutLength: Schema.optional(Schema.Number),
  stderrLength: Schema.optional(Schema.Number),
  outputLength: Schema.optional(Schema.Number),
  reason: ForwardCompatibleOptional(GitCommandFailureReason),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const reason = this.reason === undefined ? "" : ` (${this.reason})`;
    return `Git command failed in ${this.operation} (${this.cwd}): ${this.detail}${reason}`;
  }
}

export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitManagerError extends Schema.TaggedError<GitManagerError>()("GitManagerError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git manager failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitPullRequestMaterializationError extends Schema.TaggedError<GitPullRequestMaterializationError>()(
  "GitPullRequestMaterializationError",
  {
    cwd: TrimmedNonEmptyStringSchema,
    pullRequestNumber: PositiveInt,
    headRepository: Schema.NullOr(TrimmedNonEmptyStringSchema),
    headBranch: TrimmedNonEmptyStringSchema,
    localBranch: TrimmedNonEmptyStringSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to materialize pull request #${this.pullRequestNumber} branch ${this.headBranch} as ${this.localBranch}.`;
  }
}

export const GitManagerServiceError = Schema.Union([
  GitManagerError,
  GitPullRequestMaterializationError,
  GitCommandError,
  SourceControlProviderError,
  TextGenerationError,
]);
export type GitManagerServiceError = typeof GitManagerServiceError.Type;

const GitActionProgressBase = Schema.Struct({
  actionId: TrimmedNonEmptyStringSchema,
  cwd: TrimmedNonEmptyStringSchema,
  action: GitStackedAction,
});

const GitActionStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_started"),
  phases: Schema.Array(GitActionProgressPhase),
});
const GitActionPhaseStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("phase_started"),
  phase: GitActionProgressPhase,
  label: TrimmedNonEmptyStringSchema,
});
const GitActionHookStartedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_started"),
  hookName: TrimmedNonEmptyStringSchema,
});
const GitActionHookOutputEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_output"),
  hookName: Schema.NullOr(TrimmedNonEmptyStringSchema),
  stream: GitActionProgressStream,
  text: TrimmedNonEmptyStringSchema,
});
const GitActionHookFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("hook_finished"),
  hookName: TrimmedNonEmptyStringSchema,
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: Schema.NullOr(NonNegativeInt),
});
const GitActionFinishedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_finished"),
  result: GitRunStackedActionResult,
});
const GitActionFailedEvent = Schema.Struct({
  ...GitActionProgressBase.fields,
  kind: Schema.Literal("action_failed"),
  phase: Schema.NullOr(GitActionProgressPhase),
  message: TrimmedNonEmptyStringSchema,
});

export const GitActionProgressEvent = Schema.Union([
  GitActionStartedEvent,
  GitActionPhaseStartedEvent,
  GitActionHookStartedEvent,
  GitActionHookOutputEvent,
  GitActionHookFinishedEvent,
  GitActionFinishedEvent,
  GitActionFailedEvent,
]);
export type GitActionProgressEvent = typeof GitActionProgressEvent.Type;
