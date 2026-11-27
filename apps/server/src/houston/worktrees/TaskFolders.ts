// The task folders a multi-repository worktree thread works in: one worktree per chosen
// repository, laid out like the project and on one branch name.
import { GitCommandError, type ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskFolderRecord,
  HoustonTaskFolderRepository,
} from "@houston-app/contracts/houston/taskFolders";
import * as HostProcess from "@houston-app/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import * as HoustonTaskFolderStore from "./TaskFolderStore.ts";

/** One repository a project resolves, as the launch asks for it. */
export interface TaskFolderRepositoryChoice {
  readonly key: string;
  /** The repository's own checkout. */
  readonly projectPath: string;
}

/** A task folder decided before anything is created; `root` is allocated on create. */
export interface TaskFolderPlan {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly repositories: ReadonlyArray<TaskFolderRepositoryChoice>;
  /** Repositories skipped while planning, with the reason, in the project's order. */
  readonly skipped: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
}

export class TaskFolderError extends Schema.TaggedError<TaskFolderError>()("TaskFolderError", {
  operation: Schema.Literals(["plan", "create", "remove", "read"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface TaskFolderRemoval {
  readonly removed: boolean;
  readonly kept: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

export interface HoustonTaskFoldersShape {
  readonly plan: (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly repositories: ReadonlyArray<TaskFolderRepositoryChoice>;
    readonly repositoryKeys?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<TaskFolderPlan | null, TaskFolderError>;
  /** Creates every worktree and the record; a failure removes what it created. */
  readonly create: (input: {
    readonly plan: TaskFolderPlan;
    readonly branch: string;
    readonly startRef: string;
    readonly baseRefName: string;
    readonly startFromOrigin: boolean;
  }) => Effect.Effect<HoustonTaskFolderRecord, TaskFolderError>;
  readonly find: (
    folderPath: string,
  ) => Effect.Effect<HoustonTaskFolderRecord | null, TaskFolderError>;
  /** Removes every repository worktree and the record. */
  readonly remove: (input: {
    readonly folderPath: string;
    readonly force: boolean;
    readonly deleteBranch: boolean;
    /** Keep files that exist only in the task folder; they are reported instead. */
    readonly preserveExistingFiles?: boolean;
  }) => Effect.Effect<TaskFolderRemoval, TaskFolderError>;
}

export class HoustonTaskFolders extends Context.Reference<HoustonTaskFoldersShape>(
  "@houston-app/cli/houston/worktrees/TaskFolders/HoustonTaskFolders",
  // A checkout without the service keeps one worktree per thread, as before.
  {
    defaultValue: () => ({
      plan: () => Effect.succeed(null),
      create: ({ plan }) =>
        Effect.fail(
          new TaskFolderError({
            operation: "create",
            detail: `Task folders are unavailable; project ${plan.projectId} cannot get one.`,
          }),
        ),
      find: () => Effect.succeed(null),
      remove: () => Effect.succeed({ removed: false, kept: [] }),
    }),
  },
) {}

const isGitCommandError = Schema.is(GitCommandError);

const LINE_BREAK = /\r?\n/;

const errorText = (cause: unknown): string => {
  if (isGitCommandError(cause)) return cause.detail.split(LINE_BREAK)[0] ?? cause.detail;
  return cause instanceof Error ? cause.message : String(cause);
};

export const layer = Layer.effect(
  HoustonTaskFolders,
  Effect.gen(function* () {
    const store = yield* HoustonTaskFolderStore.HoustonTaskFolderStore;
    const git = yield* GitWorkflow.GitWorkflowService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Digest.Digest;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;

    const fail = (operation: TaskFolderError["operation"], detail: string, cause?: unknown) =>
      new TaskFolderError(
        cause === undefined ? { operation, detail } : { operation, detail, cause },
      );

    const withinProject = (projectRoot: string, target: string): boolean => {
      const relative = path.relative(projectRoot, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };

    const plan: HoustonTaskFoldersShape["plan"] = Effect.fn("HoustonTaskFolders.plan")(
      function* (input) {
        const projectRoot = path.resolve(input.projectRoot);
        const byKey = new Map(input.repositories.map((repository) => [repository.key, repository]));
        // A single-repository project keeps the one worktree it always had.
        if (input.repositories.length <= 1) return null;

        let chosen: ReadonlyArray<TaskFolderRepositoryChoice>;
        if (input.repositoryKeys === undefined) {
          chosen = input.repositories;
        } else {
          if (input.repositoryKeys.length === 0) {
            return yield* fail(
              "plan",
              `New worktree for project ${input.projectId} chose no repository; choose at least one repository.`,
            );
          }
          const available = [...byKey.keys()].join(", ");
          const selected = new Map<string, TaskFolderRepositoryChoice>();
          for (const key of input.repositoryKeys) {
            const repository = byKey.get(key);
            if (repository === undefined) {
              return yield* fail(
                "plan",
                `Repository key "${key}" is not in project ${input.projectId}; expected one of ${available}.`,
              );
            }
            selected.set(key, repository);
          }
          chosen = [...selected.values()];
        }

        const repositories: TaskFolderRepositoryChoice[] = [];
        const skipped: Array<{ key: string; reason: string }> = [];
        // The root repository's worktree is the task folder itself, so it claims the folder first.
        chosen = [...chosen].toSorted((left, right) =>
          left.key === "." ? -1 : right.key === "." ? 1 : 0,
        );
        for (const repository of chosen) {
          if (!withinProject(projectRoot, path.resolve(repository.projectPath))) {
            return yield* fail(
              "plan",
              `Repository ${repository.projectPath} lies outside the project folder ${projectRoot}; a task folder mirrors the project layout, so only repositories inside it can be checked out.`,
            );
          }
          const hasHead = yield* git
            .hasCommit({ cwd: repository.projectPath, refName: "HEAD" })
            .pipe(Effect.orElseSucceed(() => false));
          if (!hasHead) {
            skipped.push({
              key: repository.key,
              reason: `${repository.projectPath} has no commit on HEAD, so it has nothing to branch from`,
            });
            continue;
          }
          repositories.push(repository);
        }
        if (repositories.length === 0) {
          const reasons = skipped.map((entry) => `${entry.key}: ${entry.reason}`).join("; ");
          return yield* fail(
            "plan",
            `Project ${input.projectId} has no repository that can be checked out for a new worktree${reasons === "" ? "." : `: ${reasons}.`}`,
          );
        }
        return { projectId: input.projectId, projectRoot, repositories, skipped };
      },
    );

    const worktreesParent = Effect.fn("HoustonTaskFolders.worktreesParent")(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => ({
          worktreesDirectory: "",
          previousWorktreesDirectories: [],
        })),
      );
      const parent = resolveWorktreesDirectory(
        current.worktreesDirectory,
        config.worktreesDir,
        path,
        yield* HostProcess.HomeDirectory,
      );
      if (parent === null) {
        return yield* fail(
          "create",
          `The worktree location "${current.worktreesDirectory}" must be an absolute folder on this machine, not a drive root. Change it in Settings → Worktrees.`,
        );
      }
      return parent;
    });

    const allocateRoot = Effect.fn("HoustonTaskFolders.allocateRoot")(function* (
      plan: TaskFolderPlan,
      branch: string,
    ) {
      const parent = yield* worktreesParent();
      const digest = yield* crypto.digest(
        Digest.sha256,
        new TextEncoder().encode(`${plan.projectId}\0${plan.projectRoot}\0${branch}`),
      );
      let prefix = "";
      for (const character of branch.replaceAll("/", "-")) {
        if (Buffer.byteLength(prefix + character) > 23) break;
        prefix += character;
      }
      const base = path.join(
        parent,
        path.basename(plan.projectRoot) || "workspace",
        `${prefix}-${Hex.encode(digest).slice(0, 16)}`,
      );
      yield* fs.makeDirectory(path.dirname(base), { recursive: true });
      for (let suffix = 1; ; suffix += 1) {
        const root = suffix === 1 ? base : `${base}-${suffix}`;
        const claimed = yield* fs.makeDirectory(root).pipe(
          Effect.as(true),
          Effect.catchIf(
            (cause) => cause.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
        );
        if (claimed) return root;
      }
    });

    const worktreePathOf = (root: string, key: string) =>
      key === "." ? root : path.join(root, ...key.split("/"));

    const startFor = Effect.fn("HoustonTaskFolders.startFor")(function* (
      repository: TaskFolderRepositoryChoice,
      input: {
        readonly startRef: string;
        readonly baseRefName: string;
        readonly startFromOrigin: boolean;
      },
    ) {
      let refName = input.startRef;
      let baseRefName = input.baseRefName;
      if (input.startFromOrigin) {
        const remote = yield* git
          .resolveWorktreeBaseRemote({ cwd: repository.projectPath, refName: input.startRef })
          .pipe(Effect.orElseSucceed(() => null));
        if (remote !== null) {
          const fetched = yield* git
            .fetchWorktreeBaseCommit({
              cwd: repository.projectPath,
              refName: input.startRef,
              remote,
            })
            .pipe(Effect.orElseSucceed(() => null));
          if (fetched !== null) {
            refName = fetched.commitSha;
            baseRefName = `refs/remotes/${fetched.remoteRefName}`;
          }
        }
      }
      if (yield* git.hasCommit({ cwd: repository.projectPath, refName })) {
        return { refName, baseRefName };
      }
      return { refName: "HEAD", baseRefName: "HEAD" };
    });

    const create: HoustonTaskFoldersShape["create"] = Effect.fn("HoustonTaskFolders.create")(
      function* (input) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const root = yield* allocateRoot(input.plan, input.branch).pipe(
          Effect.mapError((cause) => fail("create", errorText(cause), cause)),
        );
        const realPath = yield* fs
          .realPath(root)
          .pipe(Effect.orElseSucceed(() => path.resolve(root)));
        const created: HoustonTaskFolderRepository[] = [];
        const record = (): HoustonTaskFolderRecord => ({
          folderPath: root,
          realPath,
          projectId: input.plan.projectId,
          projectRoot: input.plan.projectRoot,
          repositories: [...created],
          createdAt,
        });
        yield* store
          .record({ ...record(), createdAt })
          .pipe(Effect.mapError((cause) => fail("create", errorText(cause), cause)));

        const rollback = () =>
          Effect.forEach(
            [...created].reverse(),
            (repository) =>
              git
                .removeWorktree({
                  cwd: repository.projectPath,
                  path: repository.worktreePath,
                  force: true,
                })
                .pipe(
                  Effect.andThen(
                    git
                      .deleteLocalBranch({
                        cwd: repository.projectPath,
                        refName: repository.branch,
                        force: true,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("task folder rollback could not delete a branch", {
                            path: repository.worktreePath,
                            branch: repository.branch,
                            cause,
                          }),
                        ),
                      ),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("task folder rollback could not remove a worktree", {
                      path: repository.worktreePath,
                      cause,
                    }),
                  ),
                ),
            { discard: true },
          ).pipe(
            Effect.andThen(fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore)),
            Effect.andThen(store.delete(root).pipe(Effect.orElseSucceed(() => false))),
          );

        const outcome = yield* Effect.gen(function* () {
          for (const repository of input.plan.repositories) {
            const worktreePath = worktreePathOf(root, repository.key);
            yield* fs.makeDirectory(path.dirname(worktreePath), { recursive: true });
            const start = yield* startFor(repository, input);
            yield* git.createWorktree({
              cwd: repository.projectPath,
              refName: start.refName,
              newRefName: input.branch,
              baseRefName: start.baseRefName,
              path: worktreePath,
            });
            created.push({
              key: repository.key,
              projectPath: repository.projectPath,
              worktreePath,
              branch: input.branch,
            });
            yield* store
              .record({ ...record(), createdAt })
              .pipe(Effect.mapError((cause) => fail("create", errorText(cause), cause)));
          }
          return record();
        }).pipe(
          Effect.catch((cause) =>
            rollback().pipe(
              Effect.andThen(
                Effect.fail(
                  fail(
                    "create",
                    `Could not create the task folder ${root}: ${errorText(cause)}`,
                    cause,
                  ),
                ),
              ),
            ),
          ),
        );
        return outcome;
      },
    );

    const find: HoustonTaskFoldersShape["find"] = Effect.fn("HoustonTaskFolders.find")(
      function* (folderPath) {
        const resolved = path.resolve(folderPath);
        return yield* store
          .findByPath(resolved)
          .pipe(Effect.mapError((cause) => fail("read", errorText(cause), cause)));
      },
    );

    const remove: HoustonTaskFoldersShape["remove"] = Effect.fn("HoustonTaskFolders.remove")(
      function* (input) {
        const folderPath = path.resolve(input.folderPath);
        const taskFolder = yield* store.findByPath(folderPath).pipe(
          Effect.mapError((cause) => fail("remove", errorText(cause), cause)),
          Effect.map((found) => found ?? null),
        );
        if (taskFolder === null) return { removed: false, kept: [] };
        const kept: Array<{ path: string; reason: string }> = [];
        for (const repository of taskFolder.repositories) {
          yield* git
            .removeWorktree({
              cwd: repository.projectPath,
              path: repository.worktreePath,
              force: input.force,
            })
            .pipe(
              Effect.andThen(
                input.deleteBranch
                  ? git
                      .deleteLocalBranch({
                        cwd: repository.projectPath,
                        refName: repository.branch,
                        force: true,
                      })
                      .pipe(Effect.ignoreCause({ log: true }))
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  kept.push({
                    path: repository.worktreePath,
                    reason: errorText(cause instanceof Object && "cause" in cause ? cause : cause),
                  }),
                ),
              ),
            );
        }
        const rootKept = yield* fs
          .exists(taskFolder.folderPath)
          .pipe(Effect.orElseSucceed(() => false));
        let preservedRoot = false;
        if (rootKept) {
          if (input.preserveExistingFiles === true) {
            const entries = yield* fs
              .readDirectory(taskFolder.folderPath)
              .pipe(Effect.orElseSucceed(() => []));
            const owned = new Set(
              taskFolder.repositories
                .map((repository) => path.relative(taskFolder.folderPath, repository.worktreePath))
                .filter((relative) => relative !== "")
                .map((relative) => relative.split(path.sep)[0]!),
            );
            const extra = entries.filter((entry) => !owned.has(entry));
            if (extra.length > 0) {
              preservedRoot = true;
              kept.push({
                path: taskFolder.folderPath,
                reason: `holds files that exist only in this task folder: ${extra.join(", ")}`,
              });
            } else {
              yield* fs
                .remove(taskFolder.folderPath, { recursive: true, force: true })
                .pipe(Effect.ignoreCause({ log: true }));
            }
          } else {
            yield* fs
              .remove(taskFolder.folderPath, { recursive: true, force: true })
              .pipe(Effect.ignoreCause({ log: true }));
          }
        }
        if (!preservedRoot) {
          yield* store
            .delete(taskFolder.folderPath)
            .pipe(Effect.mapError((cause) => fail("remove", errorText(cause), cause)));
        }
        return { removed: true, kept };
      },
    );

    return HoustonTaskFolders.of({ plan, create, find, remove });
  }),
);
