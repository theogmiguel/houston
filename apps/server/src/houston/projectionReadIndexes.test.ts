// Boot reads of threads and provider threads use the Houston read indexes instead of parsing every
// payload, and return what the payload filters they replace return.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type Compiled = readonly [string, ReadonlyArray<unknown>];

const layer = Layer.fresh(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

/** Runs `read`, then returns the plan of each statement it ran that mentions `marker`. */
const plansOf = <A, E, R>(marker: string, read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<Compiled> = [];
    const record: Statement.Transformer = (statement) => {
      const compiled = statement.compile();
      if (compiled[0].includes(marker)) statements.push(compiled);
      return Effect.succeed(statement);
    };
    const result = yield* read.pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.isNotEmpty(statements, `a statement mentions ${marker}`);
    const plans: Array<ReadonlyArray<string>> = [];
    for (const [query, params] of statements) {
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`,
        params,
      );
      plans.push(plan.map((row) => row.detail));
    }
    return { result, plans };
  });

const assertUsesIndex = (plans: ReadonlyArray<ReadonlyArray<string>>, index: string) => {
  const details = plans.flat();
  assert.isTrue(
    details.some((detail) => detail.includes(`INDEX ${index}`)),
    `${index} is used: ${details.join(" | ")}`,
  );
  for (const detail of details) {
    assert.notMatch(
      detail,
      /^SCAN orchestration_v2_projection_(provider_)?threads$/,
      "no full scan of the thread tables",
    );
  }
};

// Composed fixture: rows with the payload keys the boot reads filter on, written as raw rows so
// each key can vary alone; archived and deleted times match their columns, as every write keeps them.
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const thread = (
    id: string,
    keys: object,
    options: { readonly archivedAt?: string; readonly deletedAt?: string } = {},
  ) => {
    const payload = {
      ...keys,
      archivedAt: options.archivedAt ?? null,
      deletedAt: options.deletedAt ?? null,
    };
    return sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
      default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at,
      updated_at, archived_at, deleted_at, payload_json)
    VALUES (${id}, 'project', ${id}, 'codex', 'codex', 'full-access', 'default',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${options.archivedAt ?? null},
      ${options.deletedAt ?? null}, ${JSON.stringify(payload)})
  `;
  };
  yield* thread("thread:tree", { worktreePath: "/work/tree" });
  yield* thread(
    "thread:archived-tree",
    { worktreePath: "/work/old" },
    { archivedAt: "2026-01-02" },
  );
  yield* thread("thread:deleted-tree", { worktreePath: "/work/gone" }, { deletedAt: "2026-01-02" });
  yield* thread("thread:subagent", { lineage: { relationshipToParent: "subagent" } });
  yield* thread(
    "thread:archived-subagent",
    { lineage: { relationshipToParent: "subagent" } },
    { archivedAt: "2026-01-02" },
  );
  yield* thread("thread:side", { lineage: { relationshipToParent: "side" } });
  yield* thread("thread:resume", {
    limitRecovery: { autoResume: true, resetAt: "2026-03-01T00:00:00.000Z" },
    snoozedUntil: "2026-02-01T00:00:00.000Z",
  });
  yield* thread("thread:no-resume", {
    limitRecovery: { autoResume: false, resetAt: "2026-01-15T00:00:00.000Z" },
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id,
      provider, status, updated_at, payload_json)
    VALUES
      ('provider:pending', 'thread:tree', 'codex', 'idle', '2026-01-01',
        ${JSON.stringify({ pendingBackgroundTasks: [{ id: "task" }] })}),
      ('provider:active', 'thread:subagent', 'codex', 'active', '2026-01-01', '{}'),
      ('provider:idle', 'thread:side', 'codex', 'idle', '2026-01-01',
        ${JSON.stringify({ pendingBackgroundTasks: [] })})
  `;
});

describe("boot reads use the Houston read indexes", () => {
  it.effect("worktree paths read the covering index and match the payload filter", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (const includeArchived of [false, true]) {
        const { result, plans } = yield* plansOf(
          "'$.worktreePath') IS NOT NULL",
          store.getThreadWorktreePaths({ includeArchived }),
        );
        assertUsesIndex(plans, "houston_threads_worktree_idx");
        const expected = yield* sql<{ readonly thread_id: string; readonly worktree_path: string }>`
          SELECT thread_id, json_extract(payload_json, '$.worktreePath') AS worktree_path
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            ${includeArchived ? sql`` : sql`AND json_extract(payload_json, '$.archivedAt') IS NULL`}
            AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
        `;
        const sorted = (rows: ReadonlyArray<{ threadId: string; worktreePath: string }>) =>
          rows.toSorted((left, right) => left.threadId.localeCompare(right.threadId));
        assert.deepEqual(
          sorted(result),
          sorted(
            expected.map((row) => ({ threadId: row.thread_id, worktreePath: row.worktree_path })),
          ),
        );
        assert.lengthOf(result, includeArchived ? 2 : 1);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("active subagent threads read their partial index", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const { result, plans } = yield* plansOf(
        "'$.lineage.relationshipToParent') = 'subagent'",
        store.listActiveSubagentThreadIds(),
      );
      assertUsesIndex(plans, "houston_threads_subagent_idx");
      assert.deepEqual([...result], ["thread:subagent"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("threads with pull requests read their partial index", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const { plans } = yield* plansOf("'$.pullRequests') > 0", store.getThreadsWithPullRequests());
      assertUsesIndex(plans, "houston_threads_pull_requests_idx");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("the limit-recovery wake reads only auto-resume threads", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const { result, plans } = yield* plansOf(
        "'$.limitRecovery.autoResume') = 1",
        store.getLimitRecoveryWakeAt(DateTime.makeUnsafe("2026-01-10T00:00:00.000Z")),
      );
      assertUsesIndex(plans, "houston_threads_limit_auto_resume_idx");
      assert.equal(result, Date.parse("2026-02-01T00:00:00.000Z"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runtime recovery finds pending provider threads through their partial index", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const { result, plans } = yield* plansOf(
        "'$.pendingBackgroundTasks') > 0",
        store.getRecoveryThreadIds("runtime"),
      );
      assertUsesIndex(plans, "houston_provider_threads_pending_idx");
      assert.deepEqual(result.map(String).toSorted(), ["thread:subagent", "thread:tree"]);
    }).pipe(Effect.provide(layer)),
  );
});
