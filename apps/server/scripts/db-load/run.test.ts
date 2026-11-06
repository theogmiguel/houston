import { describe, expect, it } from "vite-plus/test";

import { cloneStatement } from "./clone.ts";
import { fullScansInPlan } from "./run.ts";

const growing = new Set(["orchestration_v2_projection_threads", "orchestration_events"]);

describe("db-load plan checks", () => {
  it("flags full scans of growing tables through aliases, with or without an index", () => {
    const sql =
      "SELECT t.thread_id FROM orchestration_v2_projection_threads AS t JOIN orchestration_events event ON event.stream_id = t.thread_id";
    expect(
      fullScansInPlan(sql, ["SCAN t", "SEARCH event USING INDEX idx (stream_id=?)"], growing),
    ).toEqual(["orchestration_v2_projection_threads"]);
    expect(fullScansInPlan(sql, ["  SCAN event USING COVERING INDEX idx"], growing)).toEqual([
      "orchestration_events",
    ]);
  });

  it("ignores index searches, constant rows, subqueries and small tables", () => {
    const sql = "SELECT * FROM projection_projects WHERE project_id IN (SELECT 1)";
    expect(
      fullScansInPlan(
        sql,
        [
          "SCAN projection_projects",
          "SCAN CONSTANT ROW",
          "SCAN (subquery-1)",
          "  SCAN orchestration_events VIRTUAL TABLE INDEX 192:M1",
          "SEARCH orchestration_events USING INTEGER PRIMARY KEY (rowid>?)",
        ],
        growing,
      ),
    ).toEqual([]);
  });

  it("clones a unit by rewriting its token and year and offsetting task ids", () => {
    const statement = cloneStatement(
      {
        table: "houston_task_comments",
        filter: "task_id < 1000000",
        columns: [
          { name: "task_id", kind: "task" },
          { name: "body", kind: "text" },
          { name: "position", kind: "copy" },
        ],
      },
      3,
    );
    expect(statement).toContain('"task_id" + 3000000');
    expect(statement).toContain("replace(replace(\"body\", 'U0000', 'U0003'), '2026-', '2023-')");
    expect(statement).toContain('"position"');
    expect(statement).toMatch(/WHERE task_id < 1000000$/);
  });
});
