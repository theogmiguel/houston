// Where an asked bot run starts: the mode and the base ref the project's next new thread would use.
// The mode is the shared new-thread rule; the base ref is where the branch picker starts.
import type { ResolvedServerSettings } from "@houston-app/contracts";
import {
  type ResolvedProjectSettings,
  resolveNewThreadEnvMode,
  resolveSendEnvMode,
} from "@houston-app/shared/projectSettings";
import * as Effect from "effect/Effect";

/** The Git facts a workspace choice reads; each one answers "no" instead of failing. */
export interface BotWorkspaceGit {
  readonly isRepository: (cwd: string) => Effect.Effect<boolean>;
  readonly currentBranch: (cwd: string) => Effect.Effect<string | null>;
  readonly primaryRemote: (cwd: string) => Effect.Effect<string | null>;
  readonly defaultBranch: (cwd: string, remoteName: string) => Effect.Effect<string | null>;
  readonly hasRef: (cwd: string, refName: string) => Effect.Effect<boolean>;
}

export interface BotWorkspaceInput {
  readonly projectSettings: ResolvedProjectSettings<ResolvedServerSettings>;
  readonly workspaceRoot: string;
  readonly newProjectsRoot: string | null | undefined;
  readonly projectHasThreads: boolean;
}

/** The primary remote's default branch as a local branch, else its tracking ref, else the checkout, else main. */
const baseRefOf = Effect.fn("baseRefOf")(function* (git: BotWorkspaceGit, cwd: string) {
  const remoteName = yield* git.primaryRemote(cwd);
  const remoteDefault = remoteName === null ? null : yield* git.defaultBranch(cwd, remoteName);
  if (remoteName !== null && remoteDefault !== null) {
    if (yield* git.hasRef(cwd, `refs/heads/${remoteDefault}`)) return remoteDefault;
    if (yield* git.hasRef(cwd, `refs/remotes/${remoteName}/${remoteDefault}`)) {
      return `${remoteName}/${remoteDefault}`;
    }
  }
  return (yield* git.currentBranch(cwd)) ?? "main";
});

export const resolveBotWorkspace = Effect.fn("BotWorkspace.resolve")(function* (
  git: BotWorkspaceGit,
  input: BotWorkspaceInput,
) {
  const requested = resolveNewThreadEnvMode({
    projectSettings: input.projectSettings,
    workspaceRoot: input.workspaceRoot,
    newProjectsRoot: input.newProjectsRoot,
    projectHasThreads: input.projectHasThreads,
  });
  const isGitRepo = yield* git.isRepository(input.workspaceRoot);
  if (resolveSendEnvMode({ requestedEnvMode: requested, isGitRepo }) !== "worktree") {
    return { type: "root" as const };
  }
  return {
    type: "worktree" as const,
    baseRef: yield* baseRefOf(git, input.workspaceRoot),
    startFromOrigin: input.projectSettings.settings.newWorktreesStartFromOrigin,
  };
});
