// The workspace gate accepts a repository a project tracks outside its folder, and nothing else.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ThreadRepositoryResolver } from "../project/threadRepositories.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

const projectId = ProjectId.make("project:known-workspaces");

const layerFor = (workspaceRoot: string, trackedRoot: string) =>
  KnownWorkspaces.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () =>
          Effect.succeed([
            {
              id: projectId,
              workspaceRoot,
            } as unknown as OrchestrationProjectShell,
          ]),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ThreadRepositoryResolver, {
        list: () =>
          Effect.succeed([
            { key: ".", root: workspaceRoot, branch: null, baseBranch: null },
            { key: "../tracked", root: trackedRoot, branch: null, baseBranch: null },
          ]),
      }),
    ),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "houston-known-workspaces-" }),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

it.effect("accepts a tracked repository and refuses a path outside every known repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "houston-known-project-" });
    const tracked = yield* fs.makeTempDirectoryScoped({ prefix: "houston-known-tracked-" });
    const unknown = yield* fs.makeTempDirectoryScoped({ prefix: "houston-known-unknown-" });

    yield* Effect.gen(function* () {
      const workspaces = yield* KnownWorkspaces.KnownWorkspaces;
      yield* workspaces.assertContains(root);
      yield* workspaces.assertContains(tracked);
      const exit = yield* Effect.exit(workspaces.assertContains(unknown));
      assert.isTrue(exit._tag === "Failure");
      const error = exit._tag === "Failure" ? Exit.findErrorOption(exit) : Option.none();
      assert.isTrue(Option.isSome(error));
      assert.include(Option.getOrThrow(error).message, unknown);
      assert.include(Option.getOrThrow(error).message, "registered project");
    }).pipe(Effect.provide(layerFor(root, tracked)));
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
