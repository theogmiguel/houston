// The task folder rows, over an in-memory database.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as HoustonTaskFolderStore from "./TaskFolderStore.ts";

const projectId = ProjectId.make("project:task-folders");

const repository = (key: string, root: string) => ({
  key,
  projectPath: `${root}/project/${key === "." ? "" : key}`,
  worktreePath: `${root}/task/${key === "." ? "" : key}`,
  branch: "houston/worktree-task",
});

it.effect("records, finds, lists and deletes task folders by folder path", () =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskFolderStore.HoustonTaskFolderStore;
    const record = {
      folderPath: "/worktrees/project/task-1",
      realPath: "/real/worktrees/project/task-1",
      projectId,
      projectRoot: "/projects/multi",
      repositories: [repository(".", "/worktrees/project/task-1")],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    yield* store.record(record);

    assert.deepEqual(yield* store.findByPath(record.folderPath), record);
    // A resolved path finds the row stored under the path it was created as.
    assert.deepEqual(yield* store.findByPath(record.realPath), record);
    assert.deepEqual(yield* store.list(), [record]);
    assert.isTrue(yield* store.delete(record.folderPath));
    assert.isFalse(yield* store.delete(record.folderPath));
    assert.deepEqual(yield* store.list(), []);
    assert.isNull(yield* store.findByPath(record.folderPath));
  }).pipe(
    Effect.provide(
      HoustonTaskFolderStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
  ),
);

it.effect("recording the same folder path replaces its repositories", () =>
  Effect.gen(function* () {
    const store = yield* HoustonTaskFolderStore.HoustonTaskFolderStore;
    const base = {
      folderPath: "/worktrees/project/task-2",
      realPath: "/worktrees/project/task-2",
      projectId,
      projectRoot: "/projects/multi",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    yield* store.record({
      ...base,
      repositories: [repository(".", base.folderPath)],
    });
    const replaced = {
      ...base,
      repositories: [repository(".", base.folderPath), repository("web", base.folderPath)],
    };
    yield* store.record(replaced);
    assert.deepEqual(yield* store.list(), [replaced]);
  }).pipe(
    Effect.provide(
      HoustonTaskFolderStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(NodeCrypto.layer),
      ),
    ),
  ),
);
