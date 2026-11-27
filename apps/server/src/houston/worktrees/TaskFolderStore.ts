// The task folders a multi-repository worktree thread works in, keyed by folder path so
// subagents, forks and reused worktrees share one row.
import type { ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskFolderRecord,
  HoustonTaskFolderRepository,
} from "@houston-app/contracts/houston/taskFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

interface TaskFolderRow {
  readonly folder_path: string;
  readonly real_path: string;
  readonly project_id: string;
  readonly project_root: string;
  readonly repositories_json: string;
  readonly created_at: string;
}

const RepositoriesJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const decodeRepositories = Schema.decodeUnknownSync(RepositoriesJson);
const encodeRepositories = Schema.encodeSync(RepositoriesJson);

const repositoriesOf = (json: string): ReadonlyArray<HoustonTaskFolderRepository> =>
  decodeRepositories(json) as ReadonlyArray<HoustonTaskFolderRepository>;

const recordOf = (row: TaskFolderRow): HoustonTaskFolderRecord => ({
  folderPath: row.folder_path,
  realPath: row.real_path,
  projectId: row.project_id as ProjectId,
  projectRoot: row.project_root,
  repositories: repositoriesOf(row.repositories_json),
  createdAt: row.created_at,
});

export class HoustonTaskFolderStore extends Context.Service<
  HoustonTaskFolderStore,
  {
    /** Records, or replaces, the task folder at its folder path. */
    readonly record: (record: HoustonTaskFolderRecord) => Effect.Effect<void, SqlError.SqlError>;
    /** The task folder recorded at this path, named or resolved. */
    readonly findByPath: (
      folderPath: string,
    ) => Effect.Effect<HoustonTaskFolderRecord | null, SqlError.SqlError>;
    readonly list: () => Effect.Effect<ReadonlyArray<HoustonTaskFolderRecord>, SqlError.SqlError>;
    /** True when a row was removed. */
    readonly delete: (folderPath: string) => Effect.Effect<boolean, SqlError.SqlError>;
  }
>()("@houston-app/cli/houston/worktrees/TaskFolderStore/HoustonTaskFolderStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record: HoustonTaskFolderStore["Service"]["record"] = Effect.fn(
    "HoustonTaskFolderStore.record",
  )(function* (taskFolder) {
    const repositories = encodeRepositories(taskFolder.repositories);
    yield* sql`
      INSERT INTO houston_task_folders (
        folder_path, real_path, project_id, project_root, repositories_json, created_at
      ) VALUES (
        ${taskFolder.folderPath}, ${taskFolder.realPath}, ${taskFolder.projectId},
        ${taskFolder.projectRoot}, ${repositories}, ${taskFolder.createdAt}
      )
      ON CONFLICT (folder_path) DO UPDATE SET
        real_path = excluded.real_path,
        project_id = excluded.project_id,
        project_root = excluded.project_root,
        repositories_json = excluded.repositories_json
    `;
  });

  const findByPath: HoustonTaskFolderStore["Service"]["findByPath"] = Effect.fn(
    "HoustonTaskFolderStore.findByPath",
  )(function* (folderPath) {
    const rows = yield* sql<TaskFolderRow>`
      SELECT folder_path, real_path, project_id, project_root, repositories_json, created_at
      FROM houston_task_folders
      WHERE folder_path = ${folderPath} OR real_path = ${folderPath}
      ORDER BY length(folder_path) DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row === undefined ? null : recordOf(row);
  });

  const list: HoustonTaskFolderStore["Service"]["list"] = Effect.fn("HoustonTaskFolderStore.list")(
    function* () {
      const rows = yield* sql<TaskFolderRow>`
      SELECT folder_path, real_path, project_id, project_root, repositories_json, created_at
      FROM houston_task_folders
      ORDER BY created_at, folder_path
    `;
      return rows.map(recordOf);
    },
  );

  const remove: HoustonTaskFolderStore["Service"]["delete"] = Effect.fn(
    "HoustonTaskFolderStore.delete",
  )(function* (folderPath) {
    const removed = yield* sql<{ readonly folder_path: string }>`
      DELETE FROM houston_task_folders WHERE folder_path = ${folderPath} RETURNING folder_path
    `;
    return removed.length > 0;
  });

  return HoustonTaskFolderStore.of({ record, findByPath, list, delete: remove });
});

export const layer = Layer.effect(HoustonTaskFolderStore, make);
