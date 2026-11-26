// The folders a project tracks from outside its own folder, and the repository ignore patterns a
// project stores beside the ones in its houston.json.
import type { ProjectId } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export interface TrackedProjectFolder {
  readonly folderPath: string;
  readonly addedAt: string;
}

export class HoustonProjectRepositoriesStore extends Context.Service<
  HoustonProjectRepositoriesStore,
  {
    readonly listTracked: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<TrackedProjectFolder>, SqlError.SqlError>;
    readonly addTracked: (input: {
      readonly projectId: ProjectId;
      readonly folderPath: string;
      readonly addedAt: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
    /** True when a row was removed. */
    readonly removeTracked: (input: {
      readonly projectId: ProjectId;
      readonly folderPath: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly listIgnorePatterns: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<string>, SqlError.SqlError>;
    readonly setIgnorePatterns: (input: {
      readonly projectId: ProjectId;
      readonly patterns: ReadonlyArray<string>;
      readonly updatedAt: string;
    }) => Effect.Effect<void, SqlError.SqlError>;
  }
>()("@houston-app/cli/houston/projects/ProjectRepositoriesStore/HoustonProjectRepositoriesStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return HoustonProjectRepositoriesStore.of({
    listTracked: Effect.fn("HoustonProjectRepositoriesStore.listTracked")(function* (projectId) {
      const rows = yield* sql<{ readonly folder_path: string; readonly added_at: string }>`
        SELECT folder_path, added_at FROM houston_project_repositories
        WHERE project_id = ${projectId}
        ORDER BY added_at, folder_path
      `;
      return rows.map((row) => ({ folderPath: row.folder_path, addedAt: row.added_at }));
    }),

    addTracked: Effect.fn("HoustonProjectRepositoriesStore.addTracked")(function* (input) {
      yield* sql`
        INSERT INTO houston_project_repositories (project_id, folder_path, added_at)
        VALUES (${input.projectId}, ${input.folderPath}, ${input.addedAt})
        ON CONFLICT (project_id, folder_path) DO NOTHING
      `;
    }),

    removeTracked: Effect.fn("HoustonProjectRepositoriesStore.removeTracked")(function* (input) {
      const removed = yield* sql`
        DELETE FROM houston_project_repositories
        WHERE project_id = ${input.projectId} AND folder_path = ${input.folderPath}
        RETURNING folder_path
      `;
      return removed.length > 0;
    }),

    listIgnorePatterns: Effect.fn("HoustonProjectRepositoriesStore.listIgnorePatterns")(
      function* (projectId) {
        const rows = yield* sql<{ readonly pattern: string }>`
          SELECT pattern FROM houston_project_repository_ignores
          WHERE project_id = ${projectId}
          ORDER BY pattern
        `;
        return rows.map((row) => row.pattern);
      },
    ),

    setIgnorePatterns: Effect.fn("HoustonProjectRepositoriesStore.setIgnorePatterns")(
      function* (input) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM houston_project_repository_ignores WHERE project_id = ${input.projectId}`;
            yield* Effect.forEach(
              input.patterns,
              (pattern) =>
                sql`
                  INSERT INTO houston_project_repository_ignores (project_id, pattern, updated_at)
                  VALUES (${input.projectId}, ${pattern}, ${input.updatedAt})
                  ON CONFLICT (project_id, pattern) DO NOTHING
                `,
              { discard: true },
            );
          }),
        );
      },
    ),
  });
});

export const layer = Layer.effect(HoustonProjectRepositoriesStore, make);
