// A deleted project takes its tracked folders and ignore patterns with it.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  createProject,
  deleteProject,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import * as HoustonProjectRepositoriesSweep from "./ProjectRepositoriesSweep.ts";
import * as HoustonProjectRepositoriesStore from "./ProjectRepositoriesStore.ts";

const layer = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(HoustonProjectRepositoriesStore.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(layerWorkspacePaths),
  Layer.provideMerge(layerProjectMetadata),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "houston-project-repositories-deletion-" }),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const seed = Effect.fn("ProjectRepositoriesDeletionTest.seed")(function* (
  projectId: Parameters<
    HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore["Service"]["addTracked"]
  >[0]["projectId"],
  label: string,
) {
  const store = yield* HoustonProjectRepositoriesStore.HoustonProjectRepositoriesStore;
  yield* store.addTracked({
    projectId,
    folderPath: `/elsewhere/${label}`,
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  yield* store.setIgnorePatterns({
    projectId,
    patterns: [`${label}-legacy`],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

const rowCounts = Effect.fn("ProjectRepositoriesDeletionTest.rowCounts")(function* (
  projectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const tracked = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM houston_project_repositories WHERE project_id = ${projectId}
  `;
  const ignores = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM houston_project_repository_ignores WHERE project_id = ${projectId}
  `;
  return { tracked: tracked[0]?.n ?? 0, ignores: ignores[0]?.n ?? 0 };
});

it.effect("deleting a project removes its tracked folders and ignore patterns only", () =>
  Effect.gen(function* () {
    const gone = yield* createProject("repositories-gone");
    const kept = yield* createProject("repositories-kept");
    yield* seed(gone, "gone");
    yield* seed(kept, "kept");
    assert.deepEqual(yield* rowCounts(gone), { tracked: 1, ignores: 1 });

    yield* deleteProject(gone);

    assert.deepEqual(yield* rowCounts(gone), { tracked: 0, ignores: 0 });
    assert.deepEqual(yield* rowCounts(kept), { tracked: 1, ignores: 1 });
  }).pipe(Effect.provide(layer)),
);

it.effect("the startup sweep removes rows of a project whose deletion hook never ran", () =>
  Effect.gen(function* () {
    const gone = yield* createProject("repositories-swept");
    const kept = yield* createProject("repositories-swept-kept");
    yield* deleteProject(gone);
    // The deletion committed but the server stopped before the hook: the rows are back.
    yield* seed(gone, "swept");
    yield* seed(kept, "swept-kept");
    assert.deepEqual(yield* rowCounts(gone), { tracked: 1, ignores: 1 });

    yield* HoustonProjectRepositoriesSweep.sweep;

    assert.deepEqual(yield* rowCounts(gone), { tracked: 0, ignores: 0 });
    assert.deepEqual(yield* rowCounts(kept), { tracked: 1, ignores: 1 });
    // A second start finds nothing left to sweep.
    yield* HoustonProjectRepositoriesSweep.sweep;
    assert.deepEqual(yield* rowCounts(kept), { tracked: 1, ignores: 1 });
  }).pipe(Effect.provide(layer)),
);
