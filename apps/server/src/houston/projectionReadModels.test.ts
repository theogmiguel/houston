// The shell read models against the payload_json reads they replace. Rows are composed with direct
// SQL, the way upstream's own migrations and replays write them.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@houston-app/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runHoustonMigrations } from "./migrations.ts";
import { ensureHoustonReadModels } from "./projectionReadModels.ts";

const AT = "2026-01-01T00:00:00.000Z";
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const insertThread = (id: string, payload: unknown, options: { updatedAt?: string } = {}) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
        default_provider, provider_instance_id, runtime_mode, interaction_mode, created_at,
        updated_at, archived_at, deleted_at, payload_json)
      VALUES (${id}, 'project', ${id}, 'codex', 'codex', 'full-access', 'default', ${AT},
        ${options.updatedAt ?? AT}, NULL, NULL,
        ${
          typeof payload === "string"
            ? payload
            : JSON.stringify({ ...(payload as object), updatedAt: options.updatedAt ?? AT })
        })
      ON CONFLICT (thread_id) DO UPDATE SET updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
    `,
  );

const insertItem = (id: string, threadId: string, runId: string | null, ordinal: number) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id,
        provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at,
        payload_json)
      VALUES (${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal}, 'command_execution',
        'completed', ${AT}, '{}')
      ON CONFLICT (turn_item_id) DO UPDATE SET thread_id = excluded.thread_id,
        run_id = excluded.run_id, ordinal = excluded.ordinal, status = excluded.status
    `,
  );

const insertMessage = (id: string, threadId: string, minute: number, payload: unknown) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, node_id, role,
        streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${threadId}, NULL, NULL, 'user', 0, ${at(minute)}, ${at(minute)},
        ${typeof payload === "string" ? payload : JSON.stringify(payload)})
    `,
  );

// The payload_json reads the read models replace, as the store ran them before.
const payloadShellKeys = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    SELECT t.thread_id, t.project_id, t.updated_at, t.deleted_at IS NOT NULL AS deleted,
      json_extract(t.payload_json, '$.archivedAt') IS NOT NULL AS archived,
      json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
      json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
      json_extract(t.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
      json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
      json_extract(t.payload_json, '$.settledOverride') AS settled_override,
      json_extract(t.payload_json, '$.settledAt') AS settled_at,
      json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
      json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
      json_extract(t.payload_json, '$.worktreePath') AS worktree_path,
      CASE
        WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
          AND json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1
          THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
        ELSE NULL
      END AS forked_from_run_source_thread_id,
      EXISTS (
        SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
        WHERE json_type(link.value, '$.watch') IS NOT NULL
      ) AS watches_pull_request
    FROM orchestration_v2_projection_threads t
    WHERE json_valid(t.payload_json)
    ORDER BY t.thread_id
  `,
);

const storedShellKeys = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    SELECT thread_id, project_id, updated_at, deleted, archived, relationship_to_parent,
      parent_thread_id, root_thread_id, side_chat, settled_override, settled_at, pinned_at,
      snoozed_until, worktree_path, forked_from_run_source_thread_id, watches_pull_request
    FROM houston_thread_shell WHERE payload_valid = 1 ORDER BY thread_id
  `,
);

const countedItems = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`
    SELECT thread_id, coalesce(run_id, '') AS run_id, COUNT(*) AS item_count
    FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, coalesce(run_id, '') ORDER BY thread_id, run_id
  `,
);

const storedCounts = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql`SELECT * FROM houston_turn_item_counts ORDER BY thread_id, run_id`,
);

const assertReadModelsMatch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  assert.deepEqual(yield* storedShellKeys, yield* payloadShellKeys);
  assert.deepEqual(yield* storedCounts, yield* countedItems);
  assert.deepEqual(
    yield* sql`SELECT message_id, thread_id, updated_at FROM houston_user_messages ORDER BY message_id`,
    yield* sql`SELECT message_id, thread_id, updated_at FROM orchestration_v2_projection_messages
      WHERE role = 'user' ORDER BY message_id`,
  );
  const threads = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads
  `;
  const shells = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM houston_thread_shell`;
  assert.strictEqual(shells[0]?.n, threads[0]?.n);
});

const THREADS: ReadonlyArray<readonly [string, unknown]> = [
  [
    "parent",
    {
      lineage: { relationshipToParent: null, parentThreadId: null, rootThreadId: "parent" },
      settledOverride: "settled",
      settledAt: at(5),
      pinnedAt: at(6),
      worktreePath: "/work/parent",
      pullRequests: [{ number: 1 }, { number: 2, watch: null }],
    },
  ],
  [
    "child",
    {
      lineage: {
        relationshipToParent: "subagent",
        parentThreadId: "parent",
        rootThreadId: "parent",
      },
      snoozedUntil: at(9),
      forkedFrom: { type: "run", threadId: "parent", runId: "run:parent" },
      pullRequests: [7, { number: 3 }],
    },
  ],
  [
    "aside",
    {
      lineage: { relationshipToParent: "fork", rootThreadId: "parent", sideChat: true },
      forkedFrom: { type: "run", threadId: "parent", runId: "run:parent" },
      archivedAt: at(3),
      settledOverride: "active",
    },
  ],
  ["bare", { lineage: { rootThreadId: "bare" } }],
];

describe("the shell read models", () => {
  it.effect("migration 13 fills them from the rows stored before it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      for (const [id, payload] of THREADS) yield* insertThread(id, payload);
      yield* insertThread("malformed", "not json");
      yield* insertItem("item:1", "parent", "run:parent", 1);
      yield* insertItem("item:2", "parent", "run:parent", 2);
      yield* insertItem("item:3", "parent", null, 3);
      yield* insertItem("item:4", "child", "run:child", 1);
      yield* runHoustonMigrations();
      yield* assertReadModelsMatch;
      const sql = yield* SqlClient.SqlClient;
      const malformed = yield* sql<{ readonly payload_valid: number; readonly archived: number }>`
        SELECT payload_valid, archived FROM houston_thread_shell WHERE thread_id = 'malformed'
      `;
      assert.deepEqual(malformed, [{ payload_valid: 0, archived: 0 }]);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
  );

  it.effect("every kind of write keeps them equal to a recomputation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, payload] of THREADS) yield* insertThread(id, payload);
      yield* assertReadModelsMatch;
      // An upsert that changes the payload, then a stream write's in-place json_set.
      yield* insertThread("bare", {
        settledAt: at(7),
        pullRequests: [{ watch: { checks: true } }],
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET updated_at = ${at(8)}, payload_json = json_set(payload_json, '$.updatedAt', ${at(8)})
        WHERE thread_id = 'child'
      `;
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${at(9)}
        WHERE thread_id = 'aside'`;
      yield* assertReadModelsMatch;

      for (let ordinal = 1; ordinal <= 5; ordinal += 1) {
        yield* insertItem(`item:${ordinal}`, "parent", ordinal <= 3 ? "run:a" : null, ordinal);
      }
      yield* insertItem("item:1", "parent", "run:a", 1); // an update of the same item
      yield* insertItem("item:2", "parent", "run:b", 2); // moved to another run
      yield* insertItem("item:5", "child", null, 5); // moved to another thread
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'item:3'`;
      yield* assertReadModelsMatch;

      // A REPLACE removes the old row without a DELETE statement, also when it moves the item.
      const replaceItem = (id: string, runId: string) => sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id,
          run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type,
          status, updated_at, payload_json)
        VALUES (${id}, 'parent', ${runId}, NULL, NULL, NULL, NULL, 9, 'command_execution',
          'completed', ${AT}, '{}')
      `;
      yield* replaceItem("item:1", "run:a");
      yield* replaceItem("item:1", "run:c");
      yield* replaceItem("item:new", "run:c");
      yield* assertReadModelsMatch;

      // A copy through SELECT *, then a replay's wipe and refill.
      yield* sql`CREATE TEMP TABLE copied AS SELECT * FROM orchestration_v2_projection_threads
        WHERE thread_id = 'parent'`;
      yield* sql`UPDATE copied SET thread_id = 'copy'`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM copied`;
      yield* sql`CREATE TEMP TABLE items AS SELECT * FROM orchestration_v2_projection_turn_items`;
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
      assert.deepEqual(yield* storedCounts, []);
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items SELECT * FROM items`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'child'`;
      yield* assertReadModelsMatch;
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("a streamed updatedAt bump updates the column without recomputing the row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread("parent", THREADS[0]![1]);
      // A marker only a recomputation would overwrite.
      yield* sql`UPDATE houston_thread_shell SET settled_at = 'marker'`;
      const shell = sql<{ readonly updated_at: string; readonly settled_at: string }>`
        SELECT updated_at, settled_at FROM houston_thread_shell WHERE thread_id = 'parent'
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET updated_at = ${at(30)}, payload_json = json_set(payload_json, '$.updatedAt', ${at(30)})
        WHERE thread_id = 'parent'
      `;
      assert.deepEqual(yield* shell, [{ updated_at: at(30), settled_at: "marker" }]);
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET updated_at = ${at(31)}, payload_json = json_set(payload_json, '$.updatedAt', ${at(31)},
          '$.settledAt', ${at(31)})
        WHERE thread_id = 'parent'
      `;
      assert.deepEqual(yield* shell, [{ updated_at: at(31), settled_at: at(31) }]);
      yield* assertReadModelsMatch;
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("an open recreates a dropped trigger or index and rebuilds what it missed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, payload] of THREADS) yield* insertThread(id, payload);
      assert.isFalse(yield* ensureHoustonReadModels());
      yield* sql`DROP TRIGGER houston_turn_item_counts_insert`;
      yield* sql`DROP TRIGGER houston_thread_shell_update`;
      yield* sql`DROP TRIGGER houston_user_messages_insert`;
      yield* insertMessage("message:missed", "parent", 1, { text: "hello", createdBy: "user" });
      yield* sql`DROP INDEX houston_runs_latest_executed_idx`;
      yield* sql`DROP INDEX houston_threads_worktree_idx`;
      yield* insertItem("item:missed", "parent", "run:a", 1);
      yield* insertThread("bare", { pinnedAt: at(4) });
      assert.isTrue(yield* ensureHoustonReadModels());
      yield* assertReadModelsMatch;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE name IN ('houston_runs_latest_executed_idx', 'houston_threads_worktree_idx')
      `;
      assert.lengthOf(indexes, 2);
      assert.isFalse(yield* ensureHoustonReadModels());
      yield* insertItem("item:next", "parent", "run:a", 2);
      yield* assertReadModelsMatch;
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("an open recreates a dropped read-model table and refills it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, payload] of THREADS) yield* insertThread(id, payload);
      yield* insertItem("item:1", "parent", "run:a", 1);
      yield* sql`DROP TABLE houston_turn_item_counts`;
      yield* sql`DROP TABLE houston_thread_shell`;
      assert.isTrue(yield* ensureHoustonReadModels());
      yield* insertItem("item:2", "parent", "run:a", 2);
      yield* insertThread("late", { lineage: { rootThreadId: "late" } });
      yield* assertReadModelsMatch;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema WHERE name = 'houston_thread_shell_active_idx'
      `;
      assert.lengthOf(indexes, 1);
      assert.isFalse(yield* ensureHoustonReadModels());
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("a malformed payload stays writable and still fails the shell index read", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* insertThread("parent", THREADS[0]![1]);
      yield* insertThread("broken", "not json");
      assert.isTrue((yield* Effect.exit(store.listActiveShellIndex()))._tag === "Failure");
      yield* insertThread("broken", { lineage: { rootThreadId: "broken" } });
      assert.deepEqual(
        (yield* store.listActiveShellIndex()).map((entry) => entry.id),
        ["broken", "parent"],
      );
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
  );
});

describe("the shell index reads the read model as it read payload_json", () => {
  it.effect("entries, order and liveness match the payload query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      let minute = 0;
      for (const [id, payload] of THREADS) {
        yield* insertThread(id, payload, { updatedAt: at((minute += 1)) });
      }
      yield* insertThread("idle", { lineage: { rootThreadId: "idle" } }, { updatedAt: at(0) });
      yield* insertThread("background", { lineage: { rootThreadId: "background" } });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id,
          provider, status, updated_at, payload_json)
        VALUES ('provider:busy', 'background', 'codex', 'idle', ${AT},
            ${JSON.stringify({ pendingBackgroundTasks: [{ id: "task" }] })}),
          ('provider:quiet', 'idle', 'codex', 'idle', ${AT}, '{"pendingBackgroundTasks":[]}')
      `;
      // The payload query the index read replaced.
      const expected = yield* sql<{
        readonly thread_id: string;
        readonly settled_at: string | null;
        readonly side_chat: number | null;
        readonly may_be_live: number;
      }>`
        SELECT t.thread_id,
          json_extract(t.payload_json, '$.settledAt') AS settled_at,
          json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
          (
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_provider_threads provider_thread
              WHERE provider_thread.thread_id = t.thread_id
                AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
            )
            OR EXISTS (
              SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
              WHERE json_type(link.value, '$.watch') IS NOT NULL
            )
          ) AS may_be_live
        FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        ORDER BY t.updated_at ASC, t.thread_id ASC
      `;
      const index = yield* store.listActiveShellIndex();
      assert.deepEqual(
        index.map((entry) => [
          entry.id,
          entry.settledAt === null ? null : DateTime.formatIso(entry.settledAt),
          entry.lineage.sideChat ?? null,
          entry.mayBeLive,
        ]),
        expected.map((row) => [
          row.thread_id,
          row.settled_at,
          row.side_chat === null ? null : row.side_chat === 1,
          row.may_be_live === 1,
        ]),
      );
      assert.deepEqual(
        index.filter((entry) => entry.mayBeLive).map((entry) => entry.id),
        ["background", "parent"],
      );
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
  );
});

describe("the user-message read model returns what the payload filters returned", () => {
  const MESSAGES: ReadonlyArray<readonly [string, unknown]> = [
    ["user", { text: "fix the build", createdBy: "user" }],
    ["idle-flag", { text: " /COMPACT ", createdBy: "user", idleCompaction: { at: AT } }],
    ["idle-server", { text: "/compact", createdBy: "agent", creationSource: "server" }],
    ["compact-attachment", { text: "/compact", attachments: [{}], idleCompaction: {} }],
    ["user-compact", { text: "/compact", createdBy: "user" }],
    ["agent", { text: "continue", createdBy: "agent" }],
    ["no-text", { createdBy: "user", idleCompaction: {} }],
    ["unknown-author", { text: "/compact", creationSource: "server" }],
    [
      "long",
      { text: `/compact${" ".repeat(70_000)}`, createdBy: "agent", creationSource: "server" },
    ],
  ];
  const legacyIdle = (alias: string) => `(
    ${alias}.role = 'user'
    AND lower(trim(json_extract(${alias}.payload_json, '$.text'),
      char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195,
        8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)
    )) = '/compact'
    AND coalesce(json_array_length(${alias}.payload_json, '$.attachments'), 0) = 0
    AND (
      json_extract(${alias}.payload_json, '$.idleCompaction') IS NOT NULL
      OR (
        json_extract(${alias}.payload_json, '$.createdBy') = 'agent'
        AND json_extract(${alias}.payload_json, '$.creationSource') = 'server'
      )
    )
  )`;
  const latest = (from: string, where: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql
        .unsafe<{ readonly message_id: string }>(
          `SELECT message.message_id FROM ${from} message
           WHERE message.thread_id = 'thread' AND ${where}
           ORDER BY message.updated_at DESC, message.message_id DESC LIMIT 1`,
        )
        .pipe(Effect.map((rows) => rows[0]?.message_id ?? null)),
    );
  const LEGACY = "orchestration_v2_projection_messages";
  const USER_MESSAGES = "houston_user_messages";

  it.effect("latest user message, latest user-authored message and idle compaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Each prefix of the list in turn, so the newest message is every kind once.
      for (const [index, [id, payload]] of MESSAGES.entries()) {
        yield* insertMessage(id, "thread", index, payload);
        assert.strictEqual(
          yield* latest(USER_MESSAGES, "message.idle_compaction = 0"),
          yield* latest(LEGACY, `message.role = 'user' AND NOT ${legacyIdle("message")}`),
          `latest user message after ${id}`,
        );
        assert.strictEqual(
          yield* latest(USER_MESSAGES, "message.user_authored = 1 AND message.idle_compaction = 0"),
          yield* latest(
            LEGACY,
            `message.role = 'user' AND json_extract(message.payload_json, '$.createdBy') = 'user' AND NOT ${legacyIdle("message")}`,
          ),
          `latest user-authored message after ${id}`,
        );
      }
      const ids = (statement: string) =>
        sql
          .unsafe<{ readonly message_id: string }>(statement)
          .pipe(Effect.map((rows) => rows.map((row) => row.message_id)));
      const legacyIdleIds = yield* ids(
        `SELECT message_id FROM ${LEGACY} message WHERE ${legacyIdle("message")} ORDER BY message_id`,
      );
      assert.deepEqual(
        yield* ids(
          `SELECT message_id FROM ${USER_MESSAGES} WHERE idle_compaction = 1 ORDER BY message_id`,
        ),
        legacyIdleIds,
      );
      assert.deepEqual(legacyIdleIds, ["idle-flag", "idle-server", "long"]);
      // An assistant message has no row; a role change or a delete removes one.
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id,
        node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('reply', 'thread', NULL, NULL, 'assistant', 1, ${AT}, ${AT}, '{"text":"hi"}')`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET role = 'assistant'
        WHERE message_id = 'user'`;
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'agent'`;
      assert.deepEqual(
        yield* ids(`SELECT message_id FROM ${USER_MESSAGES} ORDER BY message_id`),
        yield* ids(`SELECT message_id FROM ${LEGACY} WHERE role = 'user' ORDER BY message_id`),
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});

describe("the turn-start command flag returns what the payload filter returned", () => {
  const JAVASCRIPT_TRIM =
    " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const COMMANDS: ReadonlyArray<readonly [string, unknown]> = [
    ["compact", { text: "/compact" }],
    ["compact-padded", { text: "\u00a0 /COMPACT\n" }],
    ["compact-attachment", { text: "/compact", attachments: [{}] }],
    ["compact-args", { text: "/compact now" }],
    ["goal", { text: "/goal ship it" }],
    ["goal-padded", { text: "  /goal" }],
    ["goal-long", { text: `\u3000/goal ${"x".repeat(70_000)}` }],
    ["goal-case", { text: "/Goal ship it" }],
    ["goals", { text: "/goals" }],
    ["goal-deep", { text: `${" ".repeat(70)}/goal x` }],
    ["compact-deep", { text: `${" ".repeat(70)}/Compact${" ".repeat(3)}` }],
    ["short", { text: " /go" }],
    ["plain", { text: "fix the build" }],
    ["no-text", {}],
  ];

  it.effect("flags the user messages the /compact and /goal filters matched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [index, [id, payload]] of COMMANDS.entries()) {
        yield* insertMessage(id, "thread", index, payload);
      }
      const legacy = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM orchestration_v2_projection_messages
        WHERE thread_id = 'thread' AND (
          (role = 'user' AND lower(trim(json_extract(payload_json, '$.text'), ${JAVASCRIPT_TRIM})) = '/compact')
          OR (role = 'user' AND trim(json_extract(payload_json, '$.text'), ${JAVASCRIPT_TRIM}) GLOB '/goal*')
        ) ORDER BY message_id
      `;
      const flagged = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM houston_user_messages
        WHERE thread_id = 'thread' AND command_kind IS NOT NULL ORDER BY message_id
      `;
      assert.deepEqual(flagged, legacy);
      assert.deepEqual(
        legacy.map((row) => row.message_id),
        [
          "compact",
          "compact-attachment",
          "compact-deep",
          "compact-padded",
          "goal",
          "goal-deep",
          "goal-long",
          "goal-padded",
          "goals",
        ],
      );
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );

  it.effect("migration 17 adds the flag to a database that ran migration 13 without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runHoustonMigrations();
      // Composed fixture: migration 13 as it shipped before the command column.
      yield* sql`DROP INDEX houston_user_messages_command_idx`;
      for (const name of ["insert", "update", "delete"]) {
        yield* sql.unsafe(`DROP TRIGGER houston_user_messages_${name}`);
      }
      yield* sql`ALTER TABLE houston_user_messages DROP COLUMN command_kind`;
      yield* sql`DELETE FROM houston_sql_migrations WHERE migration_id = 17`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id,
        node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES ('before', 'thread', NULL, NULL, 'user', 0, ${AT}, ${AT}, '{"text":"/compact"}')`;
      assert.deepEqual(yield* runHoustonMigrations(), [[17, "TurnStartReadModels"]]);
      yield* insertMessage("after", "thread", 1, { text: "/goal again" });
      assert.deepEqual(
        yield* sql`SELECT message_id, command_kind FROM houston_user_messages ORDER BY message_id`,
        [
          { message_id: "after", command_kind: "goal" },
          { message_id: "before", command_kind: "compact" },
        ],
      );
      assert.deepEqual(yield* runHoustonMigrations(), []);
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
  );
});

describe("shell reads use the read models instead of scanning", () => {
  const plan = (statement: string) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql
        .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
        .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n"))),
    );

  it.effect("the index, counts and family reads search their indexes", () =>
    Effect.gen(function* () {
      const index = yield* plan(
        `SELECT shell.thread_id FROM houston_thread_shell shell
         WHERE shell.deleted = 0 AND shell.archived = 0
         ORDER BY shell.updated_at ASC, shell.thread_id ASC`,
      );
      assert.include(index, "houston_thread_shell_active_idx");
      assert.notInclude(index, "TEMP B-TREE");
      const counts = yield* plan(
        `SELECT counts.thread_id, SUM(counts.item_count) FROM houston_turn_item_counts counts
         LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = counts.run_id
         WHERE counts.thread_id IN (SELECT value FROM json_each('["a"]')) GROUP BY counts.thread_id`,
      );
      assert.include(counts, "SEARCH counts USING PRIMARY KEY");
      assert.notInclude(counts, "orchestration_v2_projection_turn_items");
      const family = yield* plan(
        `SELECT t.thread_id FROM orchestration_v2_projection_threads t
         JOIN houston_thread_shell shell ON shell.thread_id = t.thread_id
         WHERE t.deleted_at IS NULL AND shell.root_thread_id = (
           SELECT member.root_thread_id FROM houston_thread_shell member
           WHERE member.thread_id = 'a')`,
      );
      assert.include(family, "houston_thread_shell_root_idx");
      assert.notInclude(family, "SCAN t");
      const blocked = yield* plan(
        `SELECT candidate.run_id FROM orchestration_v2_projection_runs candidate
           INDEXED BY houston_runs_latest_executed_idx
         WHERE candidate.thread_id = 'a' AND candidate.status <> 'queued'
         ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
           candidate.ordinal DESC, candidate.run_id DESC LIMIT 1`,
      );
      assert.notInclude(blocked, "TEMP B-TREE");
      for (const [where, index] of [
        ["message.idle_compaction = 0", "houston_user_messages_latest_idx"],
        [
          "message.user_authored = 1 AND message.idle_compaction = 0",
          "houston_user_messages_latest_authored_idx",
        ],
      ] as const) {
        const latest = yield* plan(
          `SELECT message.updated_at FROM houston_user_messages message
           WHERE message.thread_id = 'a' AND ${where}
           ORDER BY message.updated_at DESC, message.message_id DESC LIMIT 1`,
        );
        assert.include(latest, index);
        assert.notInclude(latest, "TEMP B-TREE");
      }
    }).pipe(Effect.provide(Layer.fresh(SqlitePersistence.layerMemory))),
  );
});
