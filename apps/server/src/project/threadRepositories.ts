import type { OrchestrationV2ThreadShell } from "@houston-app/contracts";
import { ProjectId, ThreadId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * One git repository a thread works in.
 *
 * `key` is the repository's path relative to the project root; the repository at the root of the
 * project's working tree is `"."`. `root` is the absolute directory git runs in. `baseBranch` is
 * null until a thread records the branch it was cut from.
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

/**
 * The repositories a thread works in: its worktree when it has one, otherwise its project's root.
 * `lookupProject` runs only when the thread has no worktree, so a worktree thread resolves even
 * when its project is gone.
 */
export const repositoriesOf = <E, R>(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "worktreePath" | "branch">,
  lookupProject: Effect.Effect<Option.Option<{ readonly workspaceRoot: string }>, E, R>,
): Effect.Effect<
  readonly [ThreadRepository, ...ThreadRepository[]],
  E | ThreadProjectNotFoundError,
  R
> =>
  Effect.gen(function* () {
    const root =
      thread.worktreePath ??
      (yield* lookupProject.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ThreadProjectNotFoundError({
                  threadId: thread.id,
                  projectId: thread.projectId,
                }),
              ),
            onSome: (project) => Effect.succeed(project.workspaceRoot),
          }),
        ),
      ));
    return [{ key: ".", root, branch: thread.branch, baseBranch: null }] as const;
  });
