import type { OrchestrationV2ThreadShell } from "@houston-app/contracts";
import { ProjectId, ThreadId } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * One git repository a thread works in. `key` is its path relative to the project root (`"."`
 * for the root itself); `root` is the absolute directory git runs in.
 */
export interface ThreadRepository {
  readonly key: string;
  readonly root: string;
  readonly branch: string | null;
  readonly baseBranch: string | null;
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { threadId: ThreadId, projectId: ProjectId },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no worktreePath and its project ${this.projectId} was not found; expected a thread with a worktreePath or a project with a workspaceRoot.`;
  }
}

export const isThreadProjectNotFoundError = Schema.is(ThreadProjectNotFoundError);

export interface ThreadRepositoryProject {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}

/**
 * The repositories a project covers, as the runtime resolves them. The default is the project
 * folder alone, so a caller that provides nothing keeps the single-repository behaviour.
 */
export class ThreadRepositoryResolver extends Context.Reference<{
  readonly list: (
    project: ThreadRepositoryProject,
  ) => Effect.Effect<ReadonlyArray<ThreadRepository>, never>;
}>("@houston-app/cli/project/threadRepositories/ThreadRepositoryResolver", {
  defaultValue: () => ({
    list: (project) =>
      Effect.succeed([
        {
          key: ".",
          root: project.workspaceRoot,
          branch: null,
          baseBranch: null,
        },
      ]),
  }),
}) {}

/**
 * The repositories a thread works in: its worktree when it has one, otherwise every repository its
 * project covers. `lookupProject` runs only when the thread has no worktree, so a worktree thread
 * resolves even when its project is gone.
 */
export const repositoriesOf = Effect.fn("repositoriesOf")(function* <E, R>(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath" | "branch">,
  lookupProject: Effect.Effect<Option.Option<{ readonly workspaceRoot: string }>, E, R>,
) {
  if (thread.worktreePath !== null) {
    return [
      {
        key: ".",
        root: thread.worktreePath,
        branch: thread.branch,
        baseBranch: null,
      },
    ] as const;
  }
  const project = yield* lookupProject.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ThreadProjectNotFoundError({
              threadId: thread.id,
              projectId: thread.projectId,
            }),
          ),
        onSome: (project) => Effect.succeed(project),
      }),
    ),
  );
  const resolver = yield* ThreadRepositoryResolver;
  const repositories = yield* resolver.list({
    projectId: thread.projectId,
    workspaceRoot: project.workspaceRoot,
  });
  const [head, ...rest] = repositories;
  const first = head ?? {
    key: ".",
    root: project.workspaceRoot,
    branch: null,
    baseBranch: null,
  };
  return [{ ...first, branch: thread.branch ?? first.branch }, ...rest] as const;
});
