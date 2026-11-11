// Doubles for the grid tools' tests: a grid service that holds nothing, for toolkits that only
// read grids to annotate their output, and a project/thread world for the real service.
import { EnvironmentId, type ProjectId } from "@houston-app/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as HoustonGrids from "../grids.ts";

/** A grid service with no grids; any other operation is a defect, so a test that needs one says so. */
export const layerNoGrids = Layer.mock(HoustonGrids.HoustonGridService)({
  list: () => Effect.succeed([]),
});

export const GRID_TEST_ENVIRONMENT = "environment-grid-tools";

/** The real grid service over an in-memory database that knows `projects`. */
export const layerGrids = (projects: ReadonlyArray<string>) =>
  HoustonGrids.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(GRID_TEST_ENVIRONMENT)),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (projectId: ProjectId) =>
            Effect.succeed(
              projects.includes(projectId)
                ? Option.some({ projectId, deletedAt: null } as never)
                : Option.none(),
            ),
        }),
      ),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(NodeCrypto.layer),
  );

/** The thread projection row the grid service checks a placed thread against. */
export const insertThreadRow = (threadId: string, projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO houston_thread_shell (thread_id, project_id, deleted, archived, payload_valid, watches_pull_request)
      VALUES (${threadId}, ${projectId}, 0, 0, 1, 0)
    `.pipe(Effect.orDie);
  });
