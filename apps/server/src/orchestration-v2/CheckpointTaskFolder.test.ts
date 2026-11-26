// A task folder's checkpoints: the root scope captures its first repository, one child scope
// captures each remaining repository, and a rewind restores every one of them.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@houston-app/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as IdAllocator from "@houston-app/provider-core/server/IdAllocator";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as HoustonTaskFolders from "../houston/worktrees/TaskFolders.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointService from "./CheckpointService.ts";

const taskFolderRecord = (root: string, api: string, web: string) => ({
  folderPath: root,
  realPath: root,
  projectId: ProjectId.make("project:checkpoint-task-folder"),
  projectRoot: "/project",
  repositories: [
    {
      key: "api",
      projectPath: api,
      worktreePath: `${root}/api`,
      branch: "thread",
    },
    {
      key: "web",
      projectPath: web,
      worktreePath: `${root}/web`,
      branch: "thread",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
});

const fakeTaskFolders = (record: ReturnType<typeof taskFolderRecord>) =>
  Layer.succeed(HoustonTaskFolders.HoustonTaskFolders, {
    plan: () => Effect.succeed(null),
    create: () => Effect.die("unused"),
    find: (folderPath: string) => Effect.succeed(folderPath === record.folderPath ? record : null),
    remove: () => Effect.die("unused"),
  } as unknown as HoustonTaskFolders.HoustonTaskFoldersShape);

const layerVcsProcess = VcsProcess.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "houston-checkpoint-task-folder-" }),
  ),
);

const serviceLayer = (record: ReturnType<typeof taskFolderRecord>) =>
  CheckpointService.layer.pipe(
    Layer.provide(Layer.mergeAll(IdAllocator.layer, layerCheckpointStore)),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(fakeTaskFolders(record)),
  );

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, never, VcsProcess.VcsProcess> =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess
      .run({
        operation: "CheckpointTaskFolder.test.git",
        command: "git",
        cwd,
        args,
        timeoutMs: 30_000,
      })
      .pipe(Effect.orDie);
    return result.stdout;
  });

const initRepository = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* git(cwd, ["init", "-q", "-b", "main"]);
    yield* git(cwd, ["config", "user.email", "test@example.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "a.txt"), "original\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-q", "-m", "init"]);
  });

interface Folders {
  readonly root: string;
  readonly api: string;
  readonly web: string;
}

const prepare = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "houston-checkpoint-task-folder-" });
  const root = path.join(base, "task-folder");
  const api = path.join(base, "api");
  const web = path.join(base, "web");
  yield* initRepository(api);
  yield* initRepository(web);
  yield* fs.makeDirectory(root, { recursive: true });
  yield* git(api, ["worktree", "add", "-q", "-b", "thread", path.join(root, "api")]);
  yield* git(web, ["worktree", "add", "-q", "-b", "thread", path.join(root, "web")]);
  return { root, api, web } satisfies Folders;
});

const rootScope = (root: string): OrchestrationV2CheckpointScope => {
  const threadId = ThreadId.make("thread:checkpoint-task-folder");
  return {
    id: CheckpointScopeId.make("checkpoint-scope:task-folder:root"),
    threadId,
    runId: RunId.make("run:checkpoint-task-folder:1"),
    nodeId: NodeId.make("node:checkpoint-task-folder:1"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:checkpoint-task-folder"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: root,
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  };
};

it.effect(
  "captures the root's first repository and a child per other repository, then rewinds both",
  () =>
    Effect.gen(function* () {
      const folders = yield* prepare;
      const record = taskFolderRecord(folders.root, folders.api, folders.web);
      const capturedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = rootScope(folders.root);

        const children = yield* checkpoints.repositoryScopes({ parent: root });
        assert.deepEqual(
          children.map((scope) => ({ cwd: scope.cwd, parent: scope.parentScopeId })),
          [{ cwd: `${folders.root}/web`, parent: root.id }],
        );
        const child = children[0]!;

        yield* checkpoints.captureBaseline({ scope: root, ordinalWithinScope: 0 });
        yield* checkpoints.captureBaseline({ scope: child, ordinalWithinScope: 0 });
        yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "changed api\n");
        yield* fs.writeFileString(path.join(folders.root, "web", "a.txt"), "changed web\n");
        const rootCheckpoint = yield* checkpoints.capture({
          scope: root,
          runId: root.runId!,
          nodeId: root.nodeId,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt,
        });
        const childCheckpoint = yield* checkpoints.capture({
          scope: child,
          runId: root.runId!,
          nodeId: root.nodeId,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt,
        });
        assert.equal(rootCheckpoint.status, "ready");
        assert.equal(childCheckpoint.status, "ready");
        assert.deepEqual(
          rootCheckpoint.files.map((file) => file.path),
          ["a.txt"],
        );

        yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "after api\n");
        yield* fs.writeFileString(path.join(folders.root, "web", "a.txt"), "after web\n");
        yield* checkpoints.restore({ scope: root, checkpoint: rootCheckpoint });
        yield* checkpoints.restore({ scope: child, checkpoint: childCheckpoint });

        assert.equal(
          yield* fs.readFileString(path.join(folders.root, "api", "a.txt")),
          "changed api\n",
        );
        assert.equal(
          yield* fs.readFileString(path.join(folders.root, "web", "a.txt")),
          "changed web\n",
        );
      }).pipe(Effect.provide(serviceLayer(record)));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerVcsProcess)),
    ),
);

it.effect("captures a task folder holding one chosen repository in its root scope", () =>
  Effect.gen(function* () {
    const folders = yield* prepare;
    const record = {
      ...taskFolderRecord(folders.root, folders.api, folders.web),
      repositories: [
        {
          key: "api",
          projectPath: folders.api,
          worktreePath: `${folders.root}/api`,
          branch: "thread",
        },
      ],
    };
    const capturedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = rootScope(folders.root);
      assert.deepEqual(yield* checkpoints.repositoryScopes({ parent: root }), []);
      yield* checkpoints.captureBaseline({ scope: root, ordinalWithinScope: 0 });
      yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "changed\n");
      const checkpoint = yield* checkpoints.capture({
        scope: root,
        runId: root.runId!,
        nodeId: root.nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt,
      });
      assert.equal(checkpoint.status, "ready");
      yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "after\n");
      yield* checkpoints.restore({ scope: root, checkpoint });
      assert.equal(yield* fs.readFileString(path.join(folders.root, "api", "a.txt")), "changed\n");
    }).pipe(Effect.provide(serviceLayer(record)));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerVcsProcess)),
  ),
);

it.effect("keeps the root's repository restored when another repository cannot be restored", () =>
  Effect.gen(function* () {
    const folders = yield* prepare;
    const record = taskFolderRecord(folders.root, folders.api, folders.web);
    const capturedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = rootScope(folders.root);
      const child = (yield* checkpoints.repositoryScopes({ parent: root }))[0]!;
      yield* checkpoints.captureBaseline({ scope: root, ordinalWithinScope: 0 });
      yield* checkpoints.captureBaseline({ scope: child, ordinalWithinScope: 0 });
      yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "changed api\n");
      yield* fs.writeFileString(path.join(folders.root, "web", "a.txt"), "changed web\n");
      const rootCheckpoint = yield* checkpoints.capture({
        scope: root,
        runId: root.runId!,
        nodeId: root.nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt,
      });
      const childCheckpoint = yield* checkpoints.capture({
        scope: child,
        runId: root.runId!,
        nodeId: root.nodeId,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        capturedAt,
      });
      yield* fs.writeFileString(path.join(folders.root, "api", "a.txt"), "changed api\n");
      // The child's worktree disappears, as a partial removal leaves it.
      yield* fs.remove(path.join(folders.root, "web"), { recursive: true, force: true });

      yield* checkpoints.restore({ scope: root, checkpoint: rootCheckpoint });
      const childRestore = yield* Effect.result(
        checkpoints.restore({ scope: child, checkpoint: childCheckpoint }),
      );

      assert.equal(childRestore._tag, "Failure");
      assert.equal(
        yield* fs.readFileString(path.join(folders.root, "api", "a.txt")),
        "changed api\n",
      );
    }).pipe(Effect.provide(serviceLayer(record)));
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, layerVcsProcess)),
  ),
);
