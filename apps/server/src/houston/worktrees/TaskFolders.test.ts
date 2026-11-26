// Task folders against real temporary git repositories.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as HoustonTaskFolderStore from "./TaskFolderStore.ts";
import * as HoustonTaskFolders from "./TaskFolders.ts";

const projectId = ProjectId.make("project:task-folders");

const layerGitWorkflow = Layer.effect(
  GitWorkflow.GitWorkflowService,
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return {
      createWorktree: (
        input: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[0],
        options?: Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[1],
      ) => driver.createWorktree(input, options),
      removeWorktree: (
        input: Parameters<GitWorkflow.GitWorkflowService["Service"]["removeWorktree"]>[0],
      ) => driver.removeWorktree(input),
      deleteLocalBranch: (
        input: Parameters<GitWorkflow.GitWorkflowService["Service"]["deleteLocalBranch"]>[0],
      ) => driver.deleteLocalBranch(input),
      resolveWorktreeBaseRemote: (
        input: Parameters<
          GitWorkflow.GitWorkflowService["Service"]["resolveWorktreeBaseRemote"]
        >[0],
      ) => driver.resolveWorktreeBaseRemote(input),
      fetchWorktreeBaseCommit: (
        input: Parameters<GitWorkflow.GitWorkflowService["Service"]["fetchWorktreeBaseCommit"]>[0],
      ) => driver.fetchWorktreeBaseCommit(input),
      hasCommit: ({ cwd, refName }: { cwd: string; refName: string }) =>
        driver.resolveCommit({ cwd, revision: refName }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
    } as unknown as GitWorkflow.GitWorkflowService["Service"];
  }),
);

const layerFor = (worktreesDirectory: string) =>
  HoustonTaskFolders.layer.pipe(
    Layer.provideMerge(HoustonTaskFolderStore.layer),
    Layer.provideMerge(layerGitWorkflow),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSettings.layerTest({ worktreesDirectory })),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "houston-task-folders-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "TaskFolders.test.git",
      cwd,
      args,
      timeoutMs: 30_000,
    });
  });

const initRepository = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "-q"]);
    yield* git(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
  });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return null;
    return Option.getOrThrow(Exit.findErrorOption(exit));
  });

const exists = (target: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(target);
  });

const withWorkspace = <A, E>(
  body: (input: {
    readonly root: string;
    readonly join: (...parts: ReadonlyArray<string>) => string;
    readonly taskFolders: HoustonTaskFolders.HoustonTaskFoldersShape;
    readonly store: HoustonTaskFolderStore.HoustonTaskFolderStore["Service"];
  }) => Effect.Effect<
    A,
    E,
    | FileSystem.FileSystem
    | Path.Path
    | GitVcsDriver.GitVcsDriver
    | HoustonTaskFolderStore.HoustonTaskFolderStore
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-task-folders-" });
    yield* Effect.gen(function* () {
      yield* body({
        root,
        join: (...parts) => path.join(root, ...parts),
        taskFolders: yield* HoustonTaskFolders.HoustonTaskFolders,
        store: yield* HoustonTaskFolderStore.HoustonTaskFolderStore,
      });
    }).pipe(Effect.provide(layerFor(path.join(root, "worktrees"))));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const twoRepositories = (join: (...parts: ReadonlyArray<string>) => string) =>
  Effect.gen(function* () {
    yield* initRepository(join("project", "api"));
    yield* initRepository(join("project", "web"));
    return {
      projectRoot: join("project"),
      repositories: [
        { key: "api", projectPath: join("project", "api") },
        { key: "web", projectPath: join("project", "web") },
      ],
    };
  });

it.effect("creates one worktree per chosen repository on one branch and removes them", () =>
  withWorkspace(({ join, taskFolders, store }) =>
    Effect.gen(function* () {
      const { projectRoot, repositories } = yield* twoRepositories(join);
      const plan = yield* taskFolders.plan({ projectId, projectRoot, repositories });
      assert.isNotNull(plan);
      const folder = yield* taskFolders.create({
        plan: plan!,
        branch: "houston/worktree-task",
        startRef: "HEAD",
        baseRefName: "HEAD",
        startFromOrigin: false,
      });

      const path = yield* Path.Path;
      assert.deepEqual(
        folder.repositories.map((repository) => ({
          key: repository.key,
          branch: repository.branch,
          worktreePath: repository.worktreePath,
        })),
        [
          {
            key: "api",
            branch: "houston/worktree-task",
            worktreePath: path.join(folder.folderPath, "api"),
          },
          {
            key: "web",
            branch: "houston/worktree-task",
            worktreePath: path.join(folder.folderPath, "web"),
          },
        ],
      );
      assert.isTrue(yield* exists(folder.repositories[0]!.worktreePath));
      assert.isTrue(yield* exists(folder.repositories[1]!.worktreePath));
      assert.deepEqual(yield* store.findByPath(folder.folderPath), folder);

      const removal = yield* taskFolders.remove({
        folderPath: folder.folderPath,
        force: true,
        deleteBranch: true,
      });
      assert.isTrue(removal.removed);
      assert.isFalse(yield* exists(folder.folderPath));
      assert.isNull(yield* store.findByPath(folder.folderPath));
      // The original checkouts are untouched and stay on their own branch.
      assert.isTrue(yield* exists(join("project", "api", ".git")));
      assert.isTrue(yield* exists(join("project", "web", ".git")));
      const branches = yield* git(join("project", "api"), ["branch", "--list"]);
      assert.isFalse(branches.stdout.includes("houston/worktree-task"));

      const again = yield* taskFolders.plan({ projectId, projectRoot, repositories });
      const created = yield* taskFolders.create({
        plan: again!,
        branch: "houston/worktree-second",
        startRef: "HEAD",
        baseRefName: "HEAD",
        startFromOrigin: false,
      });
      assert.notEqual(created.folderPath, folder.folderPath);
    }),
  ),
);

it.effect("removes every worktree it created when a later repository fails", () =>
  withWorkspace(({ join, taskFolders, store }) =>
    Effect.gen(function* () {
      const { projectRoot, repositories } = yield* twoRepositories(join);
      const plan = yield* taskFolders.plan({ projectId, projectRoot, repositories });
      assert.isNotNull(plan);
      // The second repository already holds the branch, so git refuses to create it again there.
      yield* git(join("project", "web"), ["branch", "houston/worktree-task"]);

      const failure = yield* failureOf(
        taskFolders.create({
          plan: plan!,
          branch: "houston/worktree-task",
          startRef: "HEAD",
          baseRefName: "HEAD",
          startFromOrigin: false,
        }),
      );
      assert.isNotNull(failure);
      assert.include((failure as { message: string }).message, "Could not create the task folder");

      assert.deepEqual(yield* store.list(), []);
      // Both repositories keep their own checkout and the failing repository keeps its branch.
      assert.isTrue(yield* exists(join("project", "api", ".git")));
      assert.isTrue(yield* exists(join("project", "web", ".git")));
      const branches = yield* git(join("project", "api"), ["branch", "--list"]);
      assert.isFalse(branches.stdout.includes("houston/worktree-task"));
    }),
  ),
);

it.effect("refuses unknown, empty and out-of-project repository keys by name", () =>
  withWorkspace(({ join, taskFolders }) =>
    Effect.gen(function* () {
      const { projectRoot, repositories } = yield* twoRepositories(join);
      const unknown = yield* failureOf(
        taskFolders.plan({ projectId, projectRoot, repositories, repositoryKeys: ["nope"] }),
      );
      assert.include((unknown as { message: string }).message, '"nope"');
      assert.include((unknown as { message: string }).message, "api, web");

      const empty = yield* failureOf(
        taskFolders.plan({ projectId, projectRoot, repositories, repositoryKeys: [] }),
      );
      assert.include((empty as { message: string }).message, "choose at least one repository");

      const tracked = join("elsewhere");
      yield* initRepository(tracked);
      const outside = yield* failureOf(
        taskFolders.plan({
          projectId,
          projectRoot,
          repositories: [repositories[0]!, { key: "../elsewhere", projectPath: tracked }],
        }),
      );
      assert.include((outside as { message: string }).message, "lies outside the project folder");
      assert.include((outside as { message: string }).message, "mirrors the project layout");
    }),
  ),
);

it.effect("skips a repository with no commit and refuses when none can be checked out", () =>
  withWorkspace(({ join, taskFolders }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* initRepository(join("project", "api"));
      yield* fs.makeDirectory(join("project", "web"), { recursive: true });
      yield* git(join("project", "web"), ["init", "-q"]);
      const repositories = [
        { key: "api", projectPath: join("project", "api") },
        { key: "web", projectPath: join("project", "web") },
      ];
      const plan = yield* taskFolders.plan({
        projectId,
        projectRoot: join("project"),
        repositories,
      });
      assert.deepEqual(
        plan!.repositories.map((repository) => repository.key),
        ["api"],
      );
      assert.equal(plan!.skipped.length, 1);
      assert.isTrue(plan!.skipped[0]!.reason.includes("no commit on HEAD"));

      yield* fs.makeDirectory(join("project", "docs"), { recursive: true });
      yield* git(join("project", "docs"), ["init", "-q"]);
      const none = yield* failureOf(
        taskFolders.plan({
          projectId,
          projectRoot: join("project"),
          repositories: [
            { key: "web", projectPath: join("project", "web") },
            { key: "docs", projectPath: join("project", "docs") },
          ],
        }),
      );
      assert.include(
        (none as { message: string }).message,
        "no repository that can be checked out",
      );
    }),
  ),
);

it.effect("a single-repository project keeps the single worktree behaviour", () =>
  withWorkspace(({ join, taskFolders }) =>
    Effect.gen(function* () {
      yield* initRepository(join("project", "api"));
      const plan = yield* taskFolders.plan({
        projectId,
        projectRoot: join("project"),
        repositories: [{ key: "api", projectPath: join("project", "api") }],
      });
      assert.isNull(plan);
    }),
  ),
);
