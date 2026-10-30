// @effect-diagnostics nodeBuiltinImport:off - the CLI runs against temporary Node paths.
// The offline project CLI removes a project the way the server does: its tasks are unassigned.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import { cli } from "../../binCli.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as HoustonTaskService from "./TaskService.ts";
import { layerTasks } from "./tasks.testkit.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

describe("the project CLI unassigns a removed project's tasks", () => {
  it.effect("project remove without a server leaves the task unassigned with history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-tasks-project-cli-" });
      const baseDir = NodePath.join(root, "state");
      const workspaceRoot = NodePath.join(root, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      const { dbPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]);
      const created = yield* Effect.gen(function* () {
        const [project] = yield* (yield* ProjectStore.ProjectStoreV2).list();
        assert.isDefined(project);
        const task = yield* (yield* HoustonTaskService.HoustonTaskService).save({
          patch: { title: "in the project", projectId: project!.projectId },
        });
        return { projectId: project!.projectId, key: task.key };
      }).pipe(Effect.provide(layerTasks({ databaseFile: dbPath })));

      yield* runCli(["project", "remove", created.projectId, "--base-dir", baseDir]);

      const detail = yield* HoustonTaskService.HoustonTaskService.pipe(
        Effect.flatMap((tasks) => tasks.get({ id: created.key })),
        Effect.provide(layerTasks({ databaseFile: dbPath })),
      );
      assert.isNull(detail.task.projectId);
      assert.strictEqual(detail.history[0]?.action, "houston:project-removed");
      assert.include(detail.history[0]?.changes ?? "", created.projectId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
