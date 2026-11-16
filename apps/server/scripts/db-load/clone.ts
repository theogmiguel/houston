import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { BASE_TOKEN, BASE_YEAR, unitToken } from "./fixture.ts";

/** Task ids and numbers of clone k are offset by k times this, so they never collide. */
export const TASK_ID_STRIDE = 1_000_000;

// Rebuilt or global: the message search index is rebuilt from messages after cloning.
const SKIPPED_TABLES = new Set([
  "effect_sql_migrations",
  "houston_sql_migrations",
  "orchestration_v2_projection_metadata",
  "houston_task_counter",
  "sqlite_sequence",
  // The window's arrangement, shared by every unit; cloned threads join it through their membership rows.
  "houston_layout_workspaces",
  "houston_layout_focus",
  // Trigger-maintained read models (houston/projectionReadModels.ts): cloning the source rows fills them.
  "houston_thread_shell",
  "houston_user_messages",
  "houston_turn_item_counts",
]);
const FILTER_COLUMNS = [
  "thread_id",
  "project_id",
  "stream_id",
  "effect_id",
  "command_id",
  "provider_session_id",
  "worktree_root",
];
const TASK_INTEGER_COLUMNS = new Set(["id", "task_id", "number", "parent_id", "blocked_by_id"]);

interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly pk: number;
}

export interface ClonePlan {
  readonly table: string;
  readonly filter: string;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly kind: "text" | "task" | "copy";
  }>;
}

/** Plans one INSERT ... SELECT per table that holds unit rows. */
export const planClone = Effect.fn("DbLoad.planClone")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'orchestration_v2_message_search%'
    ORDER BY rowid
  `;
  const plans: Array<ClonePlan> = [];
  for (const table of tables) {
    if (SKIPPED_TABLES.has(table.name) || /CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(table.sql)) continue;
    const count = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table.name)}`;
    if ((count[0]?.n ?? 0) === 0) continue;
    const columns =
      yield* sql<ColumnInfo>`SELECT name, type, pk FROM pragma_table_info(${table.name})`;
    const isTaskTable = table.name.startsWith("houston_task");
    const autoKey =
      /AUTOINCREMENT/i.test(table.sql) ||
      (!isTaskTable &&
        columns.some(
          (c) =>
            c.pk === 1 &&
            c.type.toUpperCase() === "INTEGER" &&
            columns.filter((o) => o.pk > 0).length === 1,
        ));
    let filter: string | undefined;
    if (table.name === "houston_tasks") filter = `id < ${TASK_ID_STRIDE}`;
    else if (isTaskTable && columns.some((c) => c.name === "task_id"))
      filter = `task_id < ${TASK_ID_STRIDE}`;
    else {
      const column = FILTER_COLUMNS.find((name) => columns.some((c) => c.name === name));
      if (column !== undefined) filter = `instr("${column}", '${BASE_TOKEN}') > 0`;
    }
    if (filter === undefined) {
      return yield* Effect.die(
        new Error(
          `Cannot clone table ${table.name}: it has rows but none of the columns ${FILTER_COLUMNS.join(", ")} or a task id.`,
        ),
      );
    }
    plans.push({
      table: table.name,
      filter,
      columns: columns
        .filter(
          (c) => !(autoKey && c.pk === 1 && c.type.toUpperCase() === "INTEGER" && !isTaskTable),
        )
        .filter(
          (c) => !(isTaskTable && c.pk === 1 && c.name === "id" && table.name !== "houston_tasks"),
        )
        .map((c) => ({
          name: c.name,
          kind:
            isTaskTable && TASK_INTEGER_COLUMNS.has(c.name) && c.type.toUpperCase() === "INTEGER"
              ? "task"
              : c.type.toUpperCase().includes("INT") ||
                  c.type.toUpperCase() === "REAL" ||
                  c.type.toUpperCase() === "BLOB"
                ? "copy"
                : "text",
        })),
    });
  }
  return plans;
});

export function cloneStatement(plan: ClonePlan, unit: number): string {
  const token = unitToken(unit);
  const year = `${String(BASE_YEAR - unit).padStart(4, "0")}-`;
  const names = plan.columns.map((c) => `"${c.name}"`).join(", ");
  const values = plan.columns
    .map((c) => {
      const column = `"${c.name}"`;
      if (c.kind === "task")
        return `CASE WHEN ${column} IS NULL THEN NULL ELSE ${column} + ${unit * TASK_ID_STRIDE} END`;
      if (c.kind === "copy") return column;
      return `CASE WHEN typeof(${column}) = 'text' THEN replace(replace(${column}, '${BASE_TOKEN}', '${token}'), '${BASE_YEAR}-', '${year}') ELSE ${column} END`;
    })
    .join(", ");
  return `INSERT INTO "${plan.table}" (${names}) SELECT ${values} FROM "${plan.table}" WHERE ${plan.filter}`;
}

/** Copies unit 0 as units 1..count-1, one transaction per unit. */
export const cloneUnits = Effect.fn("DbLoad.cloneUnits")(function* (
  count: number,
  onProgress?: (done: number, total: number) => void,
) {
  const sql = yield* SqlClient.SqlClient;
  const plans = yield* planClone();
  for (let unit = 1; unit < count; unit++) {
    yield* sql.withTransaction(
      Effect.forEach(plans, (plan) => sql.unsafe(cloneStatement(plan, unit)), { discard: true }),
    );
    onProgress?.(unit, count - 1);
  }
  yield* sql`
    UPDATE houston_task_counter SET next_number = COALESCE((SELECT MAX(number) FROM houston_tasks), 0) + 1
  `;
  return plans.map((plan) => plan.table);
});
