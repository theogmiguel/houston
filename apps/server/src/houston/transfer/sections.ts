// The Houston rows a transfer carries, by section, and the tables it never carries with the reason.
// sections.test.ts fails on a houston_* table in neither list, so a new table needs a decision.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

type Row = Record<string, unknown>;
export type SectionRows = Readonly<Record<string, ReadonlyArray<Row>>>;

export interface SectionScope {
  readonly projectId: string;
  /** The folders of the carried checkouts, as recorded in viewed-file marks. */
  readonly checkoutRoots: ReadonlyArray<string>;
}

export interface Section {
  readonly name: string;
  readonly version: number;
  readonly tables: ReadonlyArray<string>;
  readonly exportRows: (
    scope: SectionScope,
  ) => Effect.Effect<SectionRows, SqlError, SqlClient.SqlClient>;
}

const TASK_CHILDREN = [
  "houston_task_acceptance",
  "houston_task_comments",
  "houston_task_history",
  "houston_task_runs",
  "houston_task_domain",
] as const;

const tasks: Section = {
  name: "tasks",
  version: 1,
  tables: [
    "houston_tasks",
    "houston_task_acceptance",
    "houston_task_comments",
    "houston_task_history",
    "houston_task_blocks",
    "houston_task_runs",
    "houston_task_domain",
    "houston_task_planning",
    "houston_task_initiatives",
    "houston_task_settings",
  ],
  exportRows: Effect.fn("HoustonTransfer.tasksRows")(function* ({ projectId }) {
    const sql = yield* SqlClient.SqlClient;
    const ofProject = sql`SELECT id FROM houston_tasks WHERE project_id = ${projectId}`;
    const tables: Record<string, ReadonlyArray<Row>> = {
      houston_tasks: yield* sql<Row>`
        SELECT * FROM houston_tasks WHERE project_id = ${projectId} ORDER BY id
      `,
    };
    for (const table of TASK_CHILDREN) {
      tables[table] = yield* sql<Row>`
        SELECT * FROM ${sql(table)} WHERE task_id IN (${ofProject}) ORDER BY rowid
      `;
    }
    tables.houston_task_blocks = yield* sql<Row>`
      SELECT * FROM houston_task_blocks WHERE task_id IN (${ofProject})
      ORDER BY task_id, blocked_by_id
    `;
    tables.houston_task_planning = yield* sql<Row>`
      SELECT * FROM houston_task_planning WHERE task_id IN (${ofProject}) ORDER BY thread_id
    `;
    tables.houston_task_initiatives = yield* sql<Row>`
      SELECT * FROM houston_task_initiatives WHERE project_id = ${projectId} ORDER BY id
    `;
    tables.houston_task_settings = yield* sql<Row>`
      SELECT * FROM houston_task_settings WHERE project_id = ${projectId}
    `;
    return tables;
  }),
};

const taskSources: Section = {
  name: "taskSources",
  version: 1,
  tables: ["houston_task_source_settings", "houston_task_source_links"],
  exportRows: Effect.fn("HoustonTransfer.taskSourceRows")(function* ({ projectId }) {
    const sql = yield* SqlClient.SqlClient;
    return {
      houston_task_source_settings: yield* sql<Row>`
        SELECT * FROM houston_task_source_settings WHERE project_id = ${projectId}
        ORDER BY provider
      `,
      // Links of the carried tasks only: a link names its task by this server's id.
      houston_task_source_links: yield* sql<Row>`
        SELECT * FROM houston_task_source_links WHERE project_id = ${projectId}
          AND task_id IN (SELECT id FROM houston_tasks WHERE project_id = ${projectId})
        ORDER BY task_id, provider, external_id, source
      `,
    };
  }),
};

const reviewFilesViewed: Section = {
  name: "reviewFilesViewed",
  version: 1,
  tables: ["houston_review_files_viewed"],
  exportRows: Effect.fn("HoustonTransfer.viewedFileRows")(function* ({ checkoutRoots }) {
    const sql = yield* SqlClient.SqlClient;
    const marks: Array<Row> = [];
    for (const root of checkoutRoots) {
      marks.push(
        ...(yield* sql<Row>`
          SELECT * FROM houston_review_files_viewed WHERE worktree_root = ${root}
          ORDER BY ref_name, path
        `),
      );
    }
    return { houston_review_files_viewed: marks };
  }),
};

export const SECTIONS: ReadonlyArray<Section> = [tasks, taskSources, reviewFilesViewed];

/** Houston tables a transfer never carries, each with the reason. */
export const NOT_CARRIED: Readonly<Record<string, string>> = {
  houston_sql_migrations: "the schema history of this server's database",
  houston_task_counter:
    "numbers are this server's; imported tasks take the next numbers of the target's counter",
  houston_task_import: "records the one-time Houston 1 import on this server",
  houston_task_runs_cursor: "the event sequence task runs applied is this server's event store",
  houston_task_source_poll: "poll cursors and errors belong to this server's last sync",
  houston_task_source_outbox: "pending write-backs would be sent twice, once by each computer",
  houston_task_source_identity: "the marker namespace identifies this server to the trackers",
  houston_task_source_import: "records the one-time Houston 1 import on this server",
  houston_task_source_credentials:
    "indexes OS keychain entries, and tokens never leave the keychain",
  houston_merge_queue_entries: "live entries would be verified and merged by two queues",
  houston_merge_queue_settings: "the queue's policy stays with the queue that applies it",
  houston_merge_queue_log: "a record of what this server's queue pushed and merged",
  houston_merge_queue_global: "the server-wide pause belongs to this server",
  houston_transfer_exports: "this server's record of the files it wrote",
  houston_transfer_imports: "this server's record of the files it imported, and their journals",
  houston_transfer_threads: "maps this server's imported threads to their sources",
};

/** Tables in neither a section nor NOT_CARRIED, and tables claimed twice. */
export const classifyTables = (tables: ReadonlyArray<string>) => {
  const claims = new Map<string, number>();
  for (const table of [
    ...SECTIONS.flatMap((section) => section.tables),
    ...Object.keys(NOT_CARRIED),
  ]) {
    claims.set(table, (claims.get(table) ?? 0) + 1);
  }
  return {
    unclassified: tables.filter((table) => !claims.has(table)),
    twice: [...claims].filter(([, count]) => count > 1).map(([table]) => table),
  };
};
