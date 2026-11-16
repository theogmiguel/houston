import { IDLE_COMPACTION_TEXT } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Read models over upstream's projection tables, kept by triggers inside the writing statement, so
// every writer maintains them and no upstream column or writer changes. Payload keys are read only
// from valid JSON, so a malformed payload stays writable.

// Mirrors idleCompactionOf, including JavaScript trim whitespace; for a user message's payload.
const JAVASCRIPT_TRIM_CHARS =
  "char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)";

const idleCompactionSql = (payload: string) => {
  const marked = `(json_extract(${payload}, '$.idleCompaction') IS NOT NULL
      OR (json_extract(${payload}, '$.createdBy') = 'agent'
        AND json_extract(${payload}, '$.creationSource') = 'server'))`;
  // Ordered so a long user text is lowered and trimmed only for an unattached, marked message; the
  // result keeps the three-valued AND of the conditions.
  return `CASE
    WHEN json_valid(${payload}) IS NOT 1 THEN 0
    WHEN ${marked} IS 0 THEN 0
    WHEN coalesce(json_array_length(${payload}, '$.attachments'), 0) <> 0 THEN 0
    ELSE lower(trim(json_extract(${payload}, '$.text'), ${JAVASCRIPT_TRIM_CHARS})) = '${IDLE_COMPACTION_TEXT}'
      AND ${marked}
  END`;
};

// The turn-start command filters: a trimmed text of /compact (any case) or one starting with /goal.
// Most texts are rejected on the first character of the left-trimmed first 64. When those still hold
// 8, they decide the prefix, so a long text is trimmed whole only when it starts with /compact or with
// 64 whitespace characters.
const commandKindSql = (payload: string) => {
  const text = `json_extract(${payload}, '$.text')`;
  const head = `ltrim(substr(${text}, 1, 64), ${JAVASCRIPT_TRIM_CHARS})`;
  const compact = `lower(trim(${text}, ${JAVASCRIPT_TRIM_CHARS})) = '/compact'`;
  return `CASE
    WHEN json_valid(${payload}) IS NOT 1 THEN NULL
    WHEN substr(${head}, 1, 1) NOT IN ('/', '') THEN NULL
    WHEN length(${head}) >= 8 THEN CASE
      WHEN substr(${head}, 1, 5) = '/goal' THEN 'goal'
      WHEN lower(substr(${head}, 1, 8)) = '/compact' AND ${compact} THEN 'compact'
    END
    WHEN substr(ltrim(${text}, ${JAVASCRIPT_TRIM_CHARS}), 1, 5) = '/goal' THEN 'goal'
    WHEN ${compact} THEN 'compact'
  END`;
};

const userAuthoredSql = (payload: string) =>
  `CASE WHEN json_valid(${payload}) THEN json_extract(${payload}, '$.createdBy') = 'user' ELSE 0 END`;

// Shared with the query it serves: a partial index serves only a query that repeats its WHERE terms.
export const pendingBackgroundTasksSql = (payload: string) =>
  `CASE WHEN json_valid(${payload}) THEN json_array_length(${payload}, '$.pendingBackgroundTasks') > 0 ELSE 0 END`;

// One row per thread: the shell's filter and lineage keys, read without parsing payload_json.
const THREAD_SHELL_TABLE = `
  CREATE TABLE IF NOT EXISTS houston_thread_shell (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT,
    updated_at TEXT,
    deleted INTEGER NOT NULL,
    archived INTEGER NOT NULL,
    payload_valid INTEGER NOT NULL,
    relationship_to_parent,
    parent_thread_id,
    root_thread_id,
    side_chat,
    settled_override,
    settled_at,
    pinned_at,
    snoozed_until,
    worktree_path,
    forked_from_run_source_thread_id,
    watches_pull_request INTEGER NOT NULL
  ) WITHOUT ROWID
`;

// The payload keys the row needs, extracted in one pass into a small JSON array; each column then
// reads that array, not the payload. Columns keep json_extract's value types (no affinity).
const THREAD_SHELL_KEYS = [
  "$.archivedAt",
  "$.lineage",
  "$.settledOverride",
  "$.settledAt",
  "$.pinnedAt",
  "$.snoozedUntil",
  "$.worktreePath",
  "$.forkedFrom",
  "$.pullRequests",
] as const;
const key = (path: (typeof THREAD_SHELL_KEYS)[number], subpath = "") =>
  `json_extract(row.k, '$[${THREAD_SHELL_KEYS.indexOf(path)}]${subpath}')`;

const threadShellRow = (source: string) => `
  INSERT INTO houston_thread_shell (
    thread_id, project_id, updated_at, deleted, archived, payload_valid, relationship_to_parent,
    parent_thread_id, root_thread_id, side_chat, settled_override, settled_at, pinned_at,
    snoozed_until, worktree_path, forked_from_run_source_thread_id, watches_pull_request
  )
  SELECT row.thread_id, row.project_id, row.updated_at, row.deleted_at IS NOT NULL,
    ${key("$.archivedAt")} IS NOT NULL,
    row.k IS NOT NULL,
    ${key("$.lineage", ".relationshipToParent")},
    ${key("$.lineage", ".parentThreadId")},
    ${key("$.lineage", ".rootThreadId")},
    ${key("$.lineage", ".sideChat")},
    ${key("$.settledOverride")},
    ${key("$.settledAt")},
    ${key("$.pinnedAt")},
    ${key("$.snoozedUntil")},
    ${key("$.worktreePath")},
    CASE
      WHEN ${key("$.forkedFrom", ".type")} = 'run' AND ${key("$.lineage", ".sideChat")} IS NOT 1
        THEN ${key("$.forkedFrom", ".threadId")}
    END,
    EXISTS (
      SELECT 1 FROM json_each(row.k, '$[${THREAD_SHELL_KEYS.indexOf("$.pullRequests")}]') link
      WHERE CASE WHEN link.type = 'object' THEN json_type(link.value, '$.watch') IS NOT NULL END
    )
  FROM (${source}) row
`;

const threadShellSource = (from: string) => `
  SELECT ${from}.thread_id AS thread_id, ${from}.project_id AS project_id,
    ${from}.updated_at AS updated_at, ${from}.deleted_at AS deleted_at,
    CASE WHEN json_valid(${from}.payload_json)
      THEN json_extract(${from}.payload_json, ${THREAD_SHELL_KEYS.map((path) => `'${path}'`).join(", ")})
    END AS k
`;

// Turn items per thread and run ('' for items without a run), so shell counts read one row per run.
const TURN_ITEM_COUNTS_TABLE = `
  CREATE TABLE IF NOT EXISTS houston_turn_item_counts (
    thread_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    PRIMARY KEY (thread_id, run_id)
  ) WITHOUT ROWID
`;

// Statements that never conflict, so an outer statement's conflict policy cannot change them.
const countItem = (row: "new" | "old", delta: 1 | -1) => `
  INSERT INTO houston_turn_item_counts (thread_id, run_id, item_count)
  SELECT ${row}.thread_id, coalesce(${row}.run_id, ''), 0
  WHERE NOT EXISTS (
    SELECT 1 FROM houston_turn_item_counts
    WHERE thread_id = ${row}.thread_id AND run_id = coalesce(${row}.run_id, '')
  );
  UPDATE houston_turn_item_counts SET item_count = item_count + (${delta})
  WHERE thread_id = ${row}.thread_id AND run_id = coalesce(${row}.run_id, '');
  DELETE FROM houston_turn_item_counts
  WHERE thread_id = ${row}.thread_id AND run_id = coalesce(${row}.run_id, '') AND item_count <= 0;
`;

// One row per user message: when it was updated, whether it is an idle compaction or written by the
// user, and its turn-start command. A user message's write parses its payload once; other messages
// skip the triggers.
const USER_MESSAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS houston_user_messages (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT,
    updated_at TEXT,
    idle_compaction INTEGER,
    user_authored INTEGER,
    command_kind TEXT
  ) WITHOUT ROWID
`;

const userMessageRow = (from: string, where: string) => `
  INSERT INTO houston_user_messages (message_id, thread_id, updated_at, idle_compaction,
    user_authored, command_kind)
  SELECT row.message_id, row.thread_id, row.updated_at, ${idleCompactionSql("row.payload_json")},
    ${userAuthoredSql("row.payload_json")}, ${commandKindSql("row.payload_json")}
  FROM (SELECT ${from}.message_id AS message_id, ${from}.thread_id AS thread_id,
    ${from}.updated_at AS updated_at, ${from}.payload_json AS payload_json ${where}) row
`;

// True when the payload differs from the old one only in its updatedAt text, compared as bytes.
// Any other change, or a payload not written in this form, recomputes the row.
const ONLY_UPDATED_AT_CHANGED = `coalesce(
  old.thread_id = new.thread_id AND old.project_id IS new.project_id
  AND old.deleted_at IS new.deleted_at
  AND old.payload_json = replace(new.payload_json,
    '"updatedAt":"' || new.updated_at || '"', '"updatedAt":"' || old.updated_at || '"'),
  0)`;

const TRIGGERS: ReadonlyArray<readonly [name: string, sql: string]> = [
  [
    "houston_thread_shell_insert",
    `AFTER INSERT ON orchestration_v2_projection_threads BEGIN
      DELETE FROM houston_thread_shell WHERE thread_id = new.thread_id;
      ${threadShellRow(threadShellSource("new"))};
    END`,
  ],
  [
    // Each streamed event bumps updatedAt in place; that needs the column, not a payload parse.
    "houston_thread_shell_touch",
    `AFTER UPDATE OF updated_at ON orchestration_v2_projection_threads BEGIN
      UPDATE houston_thread_shell SET updated_at = new.updated_at WHERE thread_id = new.thread_id;
    END`,
  ],
  [
    "houston_thread_shell_update",
    `AFTER UPDATE ON orchestration_v2_projection_threads WHEN NOT ${ONLY_UPDATED_AT_CHANGED}
    BEGIN
      DELETE FROM houston_thread_shell WHERE thread_id IN (old.thread_id, new.thread_id);
      ${threadShellRow(threadShellSource("new"))};
    END`,
  ],
  [
    "houston_thread_shell_delete",
    `AFTER DELETE ON orchestration_v2_projection_threads BEGIN
      DELETE FROM houston_thread_shell WHERE thread_id = old.thread_id;
    END`,
  ],
  [
    "houston_user_messages_insert",
    `AFTER INSERT ON orchestration_v2_projection_messages WHEN new.role = 'user' BEGIN
      DELETE FROM houston_user_messages WHERE message_id = new.message_id;
      ${userMessageRow("new", "")};
    END`,
  ],
  [
    "houston_user_messages_update",
    `AFTER UPDATE ON orchestration_v2_projection_messages
    WHEN old.role = 'user' OR new.role = 'user' BEGIN
      DELETE FROM houston_user_messages WHERE message_id IN (old.message_id, new.message_id);
      ${userMessageRow("new", "WHERE new.role = 'user'")};
    END`,
  ],
  [
    "houston_user_messages_delete",
    `AFTER DELETE ON orchestration_v2_projection_messages WHEN old.role = 'user' BEGIN
      DELETE FROM houston_user_messages WHERE message_id = old.message_id;
    END`,
  ],
  [
    "houston_turn_item_counts_insert",
    `AFTER INSERT ON orchestration_v2_projection_turn_items BEGIN ${countItem("new", 1)} END`,
  ],
  [
    "houston_turn_item_counts_update",
    `AFTER UPDATE OF thread_id, run_id ON orchestration_v2_projection_turn_items
    WHEN old.thread_id IS NOT new.thread_id OR old.run_id IS NOT new.run_id
    BEGIN ${countItem("old", -1)} ${countItem("new", 1)} END`,
  ],
  [
    "houston_turn_item_counts_delete",
    `AFTER DELETE ON orchestration_v2_projection_turn_items BEGIN ${countItem("old", -1)} END`,
  ],
];

const rebuildUserMessages = Effect.fn("rebuildHoustonUserMessages")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM houston_user_messages`;
  yield* sql.unsafe(
    userMessageRow(
      "message",
      "FROM orchestration_v2_projection_messages message WHERE message.role = 'user'",
    ),
  );
});

const rebuildReadModels = Effect.fn("rebuildHoustonReadModels")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM houston_thread_shell`;
  yield* sql.unsafe(
    threadShellRow(`${threadShellSource("t")} FROM orchestration_v2_projection_threads t`),
  );
  yield* rebuildUserMessages();
  yield* sql`DELETE FROM houston_turn_item_counts`;
  yield* sql`
    INSERT INTO houston_turn_item_counts (thread_id, run_id, item_count)
    SELECT thread_id, coalesce(run_id, ''), COUNT(*)
    FROM orchestration_v2_projection_turn_items
    GROUP BY thread_id, coalesce(run_id, '')
  `;
});

const createTriggers = Effect.fn("createHoustonReadModelTriggers")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [name, body] of TRIGGERS) {
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${name}`);
    yield* sql.unsafe(`CREATE TRIGGER ${name} ${body}`);
  }
});

type ReadIndex = readonly [name: string, columns: string, predicate?: string];

// Migration 12: boot reads filter threads and provider threads on payload keys. Partial expression
// indexes hold just the rows that match; each read repeats its index's WHERE terms word for word.
const BOOT_READ_INDEXES: ReadonlyArray<ReadIndex> = [
  [
    "houston_threads_worktree_idx",
    "orchestration_v2_projection_threads(thread_id, json_extract(payload_json, '$.worktreePath'))",
    `deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.worktreePath') IS NOT NULL ELSE 0 END`,
  ],
  [
    "houston_threads_subagent_idx",
    "orchestration_v2_projection_threads(thread_id)",
    `deleted_at IS NULL AND CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' ELSE 0 END`,
  ],
  [
    "houston_threads_pull_requests_idx",
    "orchestration_v2_projection_threads(updated_at, thread_id)",
    `deleted_at IS NULL AND CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.archivedAt') IS NULL
      AND json_array_length(payload_json, '$.pullRequests') > 0 ELSE 0 END`,
  ],
  [
    "houston_threads_limit_auto_resume_idx",
    "orchestration_v2_projection_threads(thread_id)",
    `deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.limitRecovery.autoResume') = 1 ELSE 0 END`,
  ],
  [
    "houston_provider_threads_pending_idx",
    "orchestration_v2_projection_provider_threads(provider_thread_id, thread_id, owner_node_id)",
    `status = 'active' OR CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END`,
  ],
];

// Migration 13: the shell's message, provider-thread and run lookups.
const SHELL_READ_INDEXES: ReadonlyArray<ReadIndex> = [
  [
    "houston_provider_threads_background_idx",
    "orchestration_v2_projection_provider_threads(thread_id)",
    pendingBackgroundTasksSql("payload_json"),
  ],
  // The shell's latest-executed-run order, so a shell row stops sorting every run of its thread.
  [
    "houston_runs_latest_executed_idx",
    "orchestration_v2_projection_runs(thread_id, completed_at IS NULL, completed_at, ordinal, run_id)",
  ],
];

// Migration 16: the timeline page's item index without payloads, a covering index of the columns
// visibility and paging read.
const TIMELINE_READ_INDEXES: ReadonlyArray<ReadIndex> = [
  [
    "houston_turn_items_timeline_idx",
    "orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id, run_id, node_id, parent_item_id, type, status)",
  ],
];

// Migration 17: turn-start reads every attempt and provider turn of the thread in these orders.
const TURN_START_READ_INDEXES: ReadonlyArray<ReadIndex> = [
  [
    "houston_run_attempts_thread_order_idx",
    "orchestration_v2_projection_run_attempts(thread_id, run_id, attempt_ordinal)",
  ],
  [
    "houston_provider_turns_thread_order_idx",
    "orchestration_v2_projection_provider_turns(thread_id, provider_thread_id, ordinal)",
  ],
];

const createReadIndexes = Effect.fn("createHoustonReadIndexes")(function* (
  indexes: ReadonlyArray<ReadIndex>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [name, columns, predicate] of indexes) {
    const where = predicate === undefined ? "" : ` WHERE ${predicate}`;
    yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS ${name} ON ${columns}${where}`);
  }
});

/** Houston migration 12: indexes for the boot reads. */
export const createProjectionReadIndexes = createReadIndexes(BOOT_READ_INDEXES);

/** Houston migration 16: the timeline page's covering index. */
export const createTimelineReadIndexes = createReadIndexes(TIMELINE_READ_INDEXES);

// The read models' own tables and indexes, created if missing by the migration and at every open.
const READ_MODEL_TABLES: ReadonlyArray<readonly [name: string, ddl: ReadonlyArray<string>]> = [
  [
    "houston_thread_shell",
    [
      THREAD_SHELL_TABLE,
      `CREATE INDEX IF NOT EXISTS houston_thread_shell_active_idx
        ON houston_thread_shell(updated_at, thread_id) WHERE deleted = 0 AND archived = 0`,
      "CREATE INDEX IF NOT EXISTS houston_thread_shell_root_idx ON houston_thread_shell(root_thread_id)",
      `CREATE INDEX IF NOT EXISTS houston_thread_shell_worktree_idx
        ON houston_thread_shell(worktree_path) WHERE worktree_path IS NOT NULL`,
    ],
  ],
  [
    "houston_user_messages",
    [
      USER_MESSAGES_TABLE,
      `CREATE INDEX IF NOT EXISTS houston_user_messages_latest_idx
        ON houston_user_messages(thread_id, updated_at DESC, message_id DESC)
        WHERE idle_compaction = 0`,
      `CREATE INDEX IF NOT EXISTS houston_user_messages_latest_authored_idx
        ON houston_user_messages(thread_id, updated_at DESC, message_id DESC)
        WHERE user_authored = 1 AND idle_compaction = 0`,
      `CREATE INDEX IF NOT EXISTS houston_user_messages_command_idx
        ON houston_user_messages(thread_id) WHERE command_kind IS NOT NULL`,
    ],
  ],
  ["houston_turn_item_counts", [TURN_ITEM_COUNTS_TABLE]],
];

const createReadModelTables = Effect.fn("createHoustonReadModelTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [, ddl] of READ_MODEL_TABLES) {
    for (const statement of ddl) yield* sql.unsafe(statement);
  }
});

/** Houston migration 13: the shell's read models, filled from the rows already stored. */
export const createShellReadModels = Effect.gen(function* () {
  yield* createReadModelTables();
  yield* createTriggers();
  yield* rebuildReadModels();
  yield* createReadIndexes(SHELL_READ_INDEXES);
});

// Rebuilding a projection table drops its triggers and indexes, and a read-model table can go
// missing: at open every missing object is recreated, and a missing table or trigger rebuilds the
// read models from the upstream rows, all in one transaction.
export const ensureHoustonReadModels = Effect.fn("ensureHoustonReadModels")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const present = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE type IN ('table', 'trigger') AND name LIKE 'houston_%'
    `).map((row) => row.name),
  );
  const complete =
    READ_MODEL_TABLES.every(([name]) => present.has(name)) &&
    TRIGGERS.every(([name]) => present.has(name));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* createReadModelTables();
      yield* createReadIndexes([
        ...BOOT_READ_INDEXES,
        ...SHELL_READ_INDEXES,
        ...TIMELINE_READ_INDEXES,
        ...TURN_START_READ_INDEXES,
      ]);
      if (complete) return false;
      yield* createTriggers();
      yield* rebuildReadModels();
      return true;
    }),
  );
});

// Migration 17: the user-message command column. A database that ran migration 13 before the column
// existed gains it here; one created since already has it.
export const createTurnStartReadModels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('houston_user_messages')
  `;
  if (!columns.some((column) => column.name === "command_kind")) {
    yield* sql`ALTER TABLE houston_user_messages ADD COLUMN command_kind TEXT`;
  }
  yield* createReadModelTables();
  yield* createTriggers();
  yield* rebuildUserMessages();
  yield* createReadIndexes(TURN_START_READ_INDEXES);
});
