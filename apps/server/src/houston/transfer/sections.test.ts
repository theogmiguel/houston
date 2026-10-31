// Every Houston table is a decision: carried by one section, or named as not carried with a reason.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { classifyTables, NOT_CARRIED, SECTIONS } from "./sections.ts";

const houstonTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'houston\\_%' ESCAPE '\\'
    ORDER BY name
  `).map((row) => row.name);
});

describe("every houston table is carried by a section or listed as not carried", () => {
  it.effect("every houston table is carried by a section or listed as not carried", () =>
    Effect.gen(function* () {
      const tables = yield* houstonTables;
      assert.isAbove(tables.length, 20);
      const classified = classifyTables(tables);
      assert.deepEqual(classified.unclassified, [], "a houston table no section decides");
      assert.deepEqual(classified.twice, [], "a houston table in two places");

      // The section names and their tables are the ones the transfer promises.
      assert.deepEqual(
        SECTIONS.map((section) => section.name),
        ["tasks", "taskSources", "reviewFilesViewed"],
      );
      assert.deepEqual(SECTIONS.find((section) => section.name === "taskSources")?.tables, [
        "houston_task_source_settings",
        "houston_task_source_links",
      ]);
      for (const table of [
        "houston_task_counter",
        "houston_task_import",
        "houston_task_source_poll",
        "houston_task_source_outbox",
        "houston_task_source_identity",
        "houston_task_source_import",
        "houston_task_source_credentials",
        "houston_transfer_exports",
        "houston_transfer_imports",
        "houston_transfer_threads",
      ]) {
        assert.isString(NOT_CARRIED[table], table);
        assert.isAbove(NOT_CARRIED[table]!.length, 10, `${table} has a reason`);
      }
      // Every section and not-carried name is a real table.
      for (const table of [...SECTIONS.flatMap((section) => section.tables), ...Object.keys(NOT_CARRIED)]) {
        assert.include(tables, table);
      }

      // A table nobody decided fails, by name.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE houston_undecided_rows (id INTEGER PRIMARY KEY)`;
      assert.deepEqual(classifyTables(yield* houstonTables).unclassified, [
        "houston_undecided_rows",
      ]);
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});
