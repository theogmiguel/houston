// @effect-diagnostics nodeBuiltinImport:off - counts visited rows in a SQLite connection of its own.
// The deferred thread window groups work from its newest segments. These tests pin that the window
// is the one a grouping of the whole history gives, and that its cost stops following the history.
// The threads are composed: rows are inserted straight into the projection tables.
import { assert, describe, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqlite from "node:sqlite";

import { makeRandom } from "../../scripts/db-load/random.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  OLDER_THREAD_USER_TURN_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "../orchestration-v2/threadHistoryPaging.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const storeLayer = Layer.fresh(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);
const AT = "2026-06-01T00:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Json = Record<string, unknown>;
interface ItemSpec extends Json {
  readonly type: string;
  readonly status?: string;
  /** Written under the superseded first attempt of its run. */
  readonly firstAttempt?: true;
  /** Belongs to no run. */
  readonly runless?: true;
  /** Shares the previous item's ordinal. */
  readonly tied?: true;
  /** Belongs to an earlier run (from 1), as a late result of its background work does. */
  readonly ofRun?: number;
}
interface RunSpec {
  readonly status?: string;
  readonly superseded?: true;
  readonly items: ReadonlyArray<ItemSpec>;
}

const times = <A>(count: number, make: (index: number) => A): Array<A> =>
  Array.from({ length: count }, (_, index) => make(index));
const user = (inputIntent = "turn_start", createdBy = "user"): ItemSpec => ({
  type: "user_message",
  createdBy,
  creationSource: "web",
  inputIntent,
  text: "do it",
  attachments: [],
});
const reply: ItemSpec = { type: "assistant_message", text: "done", streaming: false };
const command: ItemSpec = { type: "command_execution", input: "ls", output: "ok", exitCode: 0 };
const reasoning: ItemSpec = { type: "reasoning", text: "because", streaming: false };
const compaction: ItemSpec = { type: "compaction", driver: "claudeAgent", summary: "before" };
const delegateTool: ItemSpec = {
  type: "dynamic_tool",
  toolName: "mcp__houston__delegate_task",
  input: {},
  output: "started",
};
const subagent: ItemSpec = {
  type: "subagent",
  origin: "app_owned",
  driver: "claudeAgent",
  providerInstanceId: "claudeAgent",
  subagentId: "node:task",
  childThreadId: "thread:child",
  prompt: "look",
  result: "found",
};
const wake: ItemSpec = {
  type: "notification",
  source: { kind: "delegated_task", taskIds: ["node:task"] },
  outcome: "updated",
  summary: "The watch fired",
};
const failure: ItemSpec = {
  type: "error",
  status: "failed",
  failure: { class: "unknown", message: "stopped", code: null, retryable: null },
};
/** `replies` rows that keep their own place, each followed by `perReply` rows that can fold. */
const work = (replies: number, perReply: number): Array<ItemSpec> =>
  times(replies, () => [
    ...times(perReply, (i) => (i % 5 === 4 ? reasoning : command)),
    reply,
  ]).flat();

const seedThread = Effect.fn("seedThread")(function* (
  name: string,
  runs: ReadonlyArray<RunSpec>,
  thread: Json = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = ThreadId.make(`thread:${name}`);
  const rows = {
    runs: [] as Array<Json>,
    attempts: [] as Array<Json>,
    nodes: [] as Array<Json>,
    items: [] as Array<Json>,
  };
  const modelSelection = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  let ordinal = 0;
  runs.forEach(({ status = "completed", superseded, items }, index) => {
    const runId = `run:${name}:${index + 1}`;
    const done = status === "completed" ? AT : null;
    const rootNodeId = (attempt: number) => `node:${runId}:${attempt}`;
    const attemptIds = superseded === true ? [1, 2] : [1];
    rows.runs.push({
      id: runId,
      threadId,
      ordinal: index + 1,
      providerInstanceId: "claudeAgent",
      modelSelection,
      providerThreadId: null,
      userMessageId: `message:${runId}`,
      rootNodeId: rootNodeId(attemptIds.at(-1)!),
      activeAttemptId: `attempt:${runId}:${attemptIds.at(-1)!}`,
      status,
      requestedAt: AT,
      startedAt: AT,
      completedAt: done,
      checkpointId: null,
      contextHandoffId: null,
    });
    for (const attempt of attemptIds) {
      const attemptStatus =
        superseded === true && attempt === 1
          ? "superseded"
          : status === "queued"
            ? "pending"
            : status === "rolled_back"
              ? "completed"
              : status;
      rows.attempts.push({
        id: `attempt:${runId}:${attempt}`,
        runId,
        attemptOrdinal: attempt,
        rootNodeId: rootNodeId(attempt),
        providerInstanceId: "claudeAgent",
        providerThreadId: "provider-thread:window",
        providerTurnId: null,
        reason: attempt === 1 ? "initial" : "steering_restart",
        status: attemptStatus,
        startedAt: AT,
        completedAt: done,
      });
      rows.nodes.push({
        id: rootNodeId(attempt),
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: rootNodeId(attempt),
        kind: "root_turn",
        status: status === "completed" ? "completed" : "running",
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: AT,
        completedAt: done,
      });
    }
    for (const { firstAttempt, runless, tied, ofRun, ...item } of items) {
      ordinal += tied === true ? 0 : 1;
      const id = `item:${name}:${rows.items.length + 1}`;
      rows.items.push({
        id,
        threadId,
        runId: runless === true ? null : ofRun === undefined ? runId : `run:${name}:${ofRun}`,
        nodeId:
          runless === true
            ? null
            : ofRun === undefined
              ? rootNodeId(firstAttempt === true ? 1 : attemptIds.at(-1)!)
              : `node:run:${name}:${ofRun}:1`,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: AT,
        completedAt: AT,
        updatedAt: AT,
        ...(item.type.endsWith("_message") ? { messageId: `message:${id}` } : {}),
        ...item,
      });
    }
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider,
      runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project:window', 'Window', 'claudeAgent', 'full-access', 'default', ${AT},
      ${AT}, ${encodeJson({
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: "project:window",
        title: "Window",
        providerInstanceId: "claudeAgent",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        ...thread,
      })})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider,
      provider_thread_id, status, requested_at, completed_at, payload_json)
    SELECT value ->> 'id', ${threadId}, value ->> 'ordinal', 'claudeAgent', NULL,
      value ->> 'status', ${AT}, value ->> 'completedAt', value
    FROM json_each(${encodeJson(rows.runs)})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id,
      attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
    SELECT value ->> 'id', ${threadId}, value ->> 'runId', value ->> 'attemptOrdinal',
      value ->> 'rootNodeId', 'claudeAgent', 'provider-thread:window', value ->> 'status', value
    FROM json_each(${encodeJson(rows.attempts)})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_nodes (node_id, thread_id, run_id, root_node_id, kind,
      status, started_at, payload_json)
    SELECT value ->> 'id', ${threadId}, value ->> 'runId', value ->> 'rootNodeId',
      value ->> 'kind', value ->> 'status', ${AT}, value
    FROM json_each(${encodeJson(rows.nodes)})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id,
      ordinal, type, status, updated_at, payload_json)
    SELECT value ->> 'id', ${threadId}, value ->> 'runId', value ->> 'nodeId',
      value ->> 'ordinal', value ->> 'type', value ->> 'status', ${AT}, value
    FROM json_each(${encodeJson(rows.items)})
  `;
  return { threadId, itemIds: rows.items.map((item) => TurnItemId.make(String(item.id))) };
});

type WindowOptions = Parameters<
  ProjectionStore.ProjectionStoreV2["Service"]["getThreadSnapshotWindow"]
>[1];
const OPEN: WindowOptions = {
  rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
  deferWork: true,
};

type Compiled = readonly [query: string, params: ReadonlyArray<unknown>];

/** Reads a window while `transform` sees each statement's SQL. */
const readWindow = (
  threadId: ThreadId,
  options: WindowOptions,
  transform: (sql: string, params: ReadonlyArray<unknown>) => Statement.Statement<unknown> | null,
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const transformer: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        const [query, params] = statement.compile();
        return (transform(query, params) ?? statement) as typeof statement;
      });
    return yield* store
      .getThreadSnapshotWindow(threadId, options)
      .pipe(Effect.provideService(Statement.CurrentTransformer, transformer));
  });

/** The window with its work grouped from the history boundary, as if no newer start were found. */
const readWholeHistoryWindow = Effect.fn("readWholeHistoryWindow")(function* (
  threadId: ThreadId,
  options: WindowOptions,
) {
  const sql = yield* SqlClient.SqlClient;
  let starts = 0;
  let rows: Compiled | undefined;
  const window = yield* readWindow(threadId, options, (query, params) => {
    if (query.includes("work_segments AS")) rows = [query, params];
    if (!query.includes("visible_tail")) return null;
    starts += 1;
    return sql`SELECT NULL AS ordinal`;
  });
  return { window, starts, rows };
});

/** The statements that find the start (if any) and read the window's rows. */
const windowStatements = Effect.fn("windowStatements")(function* (threadId: ThreadId) {
  let start: Compiled | undefined;
  let rows: Compiled | undefined;
  yield* readWindow(threadId, OPEN, (query, params) => {
    if (query.includes("visible_tail")) start = [query, params];
    if (query.includes("work_segments AS")) rows = [query, params];
    return null;
  });
  assert.isDefined(rows);
  return { start, rows };
});

const COUNTED_TABLES = ["threads", "runs", "run_attempts", "nodes", "turn_items"].map(
  (table) => `orchestration_v2_projection_${table}`,
);

/** A copy of the thread tables that counts the turn items each statement visits. */
const makeRowCounter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = new NodeSqlite.DatabaseSync(":memory:");
  yield* Effect.addFinalizer(() => Effect.sync(() => database.close()));
  for (const table of COUNTED_TABLES) {
    const schema = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_schema WHERE tbl_name = ${table} AND type IN ('table', 'index')
        AND sql IS NOT NULL ORDER BY type DESC, rowid
    `;
    for (const statement of schema) database.exec(statement.sql);
    for (const row of yield* sql<
      Record<string, NodeSqlite.SQLInputValue>
    >`SELECT * FROM ${sql(table)}`) {
      const columns = Object.keys(row);
      database
        .prepare(`INSERT INTO ${table} (${columns}) VALUES (${columns.map(() => "?")})`)
        .run(...Object.values(row));
    }
  }
  let visited = 0;
  database.function("visit", { deterministic: false, varargs: true }, () => {
    visited += 1;
    return 1;
  });
  const plan = ([query, params]: Compiled) =>
    database
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all(...(params as Array<NodeSqlite.SQLInputValue>))
      .map((row) => String(row.detail));
  return (statement: Compiled) => {
    // Each scan of the items that can grow: the eligible rows, a range's runs, a run's rows.
    const query = statement[0]
      .replace(
        /\bWHERE (item|member|prompt|first)\.(thread_id|run_id)\b/gu,
        "WHERE visit($1.rowid) AND $1.$2",
      )
      .replace(
        /(FROM orchestration_v2_projection_turn_items\s+WHERE )(thread_id = \? AND run_id IS NOT NULL)/gu,
        "$1visit(orchestration_v2_projection_turn_items.rowid) AND $2",
      );
    assert.include(query, "visit(item.rowid)");
    const counted: Compiled = [query, statement[1]];
    const plans = [plan(counted), plan(statement)] as const;
    assert.deepEqual(plans[0], plans[1], "counting does not change the plan");
    visited = 0;
    database.prepare(query).all(...(statement[1] as Array<NodeSqlite.SQLInputValue>));
    return visited;
  };
});

/** How many rows the window groups work over, counted by the read's own statement. */
const groupedRows = Effect.fn("groupedRows")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const [query, params] = (yield* windowStatements(threadId)).rows;
  const end = query.indexOf("-- CROSS JOIN keeps the sorted IDs");
  assert.isAbove(end, 0, "the window statement ends in its payload read");
  const prefix = query.slice(0, end);
  const rows = yield* sql.unsafe<{ readonly n: number }>(
    `${prefix} SELECT COUNT(*) AS n FROM work_segments`,
    params.slice(0, prefix.split("?").length - 1),
  );
  return rows[0]!.n;
});

const manyUserTurns = (turns: number): Array<RunSpec> =>
  times(turns, () => ({ items: [user(), ...work(70, 1), ...times(160, () => command), reply] }));
// Long agent work the user steers: few turn starts, so the history boundary is the first row.
const fewUserTurns = (runs: number): Array<RunSpec> =>
  times(runs, (index) => ({
    items: [
      user(index % 5 === 0 ? "turn_start" : "steer"),
      ...times(170, () => command),
      ...work(45, 4),
    ],
  }));
const notice: ItemSpec = { type: "system_notice", message: "note", runless: true };
/** A segment whose 400 oldest commands lie below the newest 502 rows that keep their place. */
const straddling = [
  ...times(400, () => command),
  ...times(500, () => reply),
  ...times(100, () => command),
  ...times(40, () => reply),
];

/** Steered work, then runs that each wake, look and report, as a thread that watches something has. */
const wakeHeavy = (runs: number, wakes: number): Array<RunSpec> => [
  ...fewUserTurns(runs),
  ...times(wakes, () => ({ items: [wake, command, reply] })),
];

/** A seeded thread of every row kind the window treats differently. */
const randomRuns = (seed: number): Array<RunSpec> => {
  const random = makeRandom(seed);
  return times(random.int(3, 9), (index) => {
    const superseded = random.chance(0.25);
    const items: Array<ItemSpec> = [
      random.chance(0.2)
        ? wake
        : user(
            random.pick([
              "turn_start",
              "steer",
              "steer",
              "queued_turn",
              "promoted_queued_to_steer",
            ]),
            random.pick(["user", "user", "agent"]),
          ),
    ];
    for (let part = random.int(2, 8); part > 0; part -= 1) {
      items.push(
        ...(random.chance(0.4)
          ? times(random.int(120, 260), () =>
              superseded && random.chance(0.5)
                ? { ...command, firstAttempt: true as const }
                : command,
            )
          : work(random.int(10, 130), random.pick([1, 1, 2, 4]))),
      );
      if (random.chance(0.3)) items.push(user(random.pick(["steer", "turn_start"])));
      if (random.chance(0.1)) items.push(compaction);
      if (random.chance(0.1)) items.push(delegateTool, subagent);
      if (random.chance(0.08)) items.push(failure);
      if (random.chance(0.05))
        items.push(
          { type: "run_interrupt_request", message: "Stop" },
          { type: "run_interrupt_result", message: "Stopped" },
        );
      if (random.chance(0.1)) items.push(notice);
      if (random.chance(0.1)) items.push({ ...reply, tied: true });
      if (superseded && random.chance(0.3))
        items.push({ type: "run_interrupt_result", message: "Steered", firstAttempt: true });
      if (random.chance(0.2)) items.push(wake);
      if (index > 0 && random.chance(0.2))
        items.push(...times(random.int(1, 6), () => ({ ...command, ofRun: random.int(1, index) })));
    }
    const status =
      index === 0
        ? "completed"
        : random.pick([
            "completed",
            "completed",
            "completed",
            "running",
            "rolled_back",
            "cancelled",
            "queued",
          ]);
    return { status, ...(superseded ? { superseded: true as const } : {}), items };
  });
};
const RANDOM_SEEDS = times(10, (index) => (index + 1) * 7_919);

const SHAPES: ReadonlyArray<readonly [name: string, runs: ReadonlyArray<RunSpec>]> = [
  ["a short thread", times(3, () => ({ items: [user(), ...work(2, 3)] }))],
  ["a long thread with many user turns", manyUserTurns(16)],
  ["a long thread with few user turns", fewUserTurns(16)],
  [
    "a thread whose newest turn is running",
    [
      ...fewUserTurns(14),
      {
        status: "running",
        items: [user(), ...work(60, 9), { ...command, status: "running" }],
      },
    ],
  ],
  [
    "a compaction in the tail",
    [
      ...fewUserTurns(14),
      { items: [user("steer"), ...times(200, () => command), compaction, ...work(200, 2)] },
      { items: [user("steer"), compaction, ...times(180, () => command), reply] },
    ],
  ],
  [
    "delegated sub-agent items in the tail",
    [
      ...fewUserTurns(14),
      {
        items: [
          user("steer"),
          ...times(40, () => [delegateTool, subagent, ...times(8, () => command)]).flat(),
          ...times(170, () => command),
          reply,
        ],
      },
    ],
  ],
  [
    "newest segments larger than one window",
    [
      ...fewUserTurns(6),
      { items: [user(), ...times(400, () => command), ...work(700, 2)] },
      { items: [user("steer"), ...work(300, 2), ...times(400, () => command)] },
    ],
  ],
  ...[499, 500, 501, 502, 503].map(
    (rows) =>
      [
        `a newest turn of ${rows} rows`,
        [...fewUserTurns(6), { items: [user(), ...times(rows - 1, () => reply)] }],
      ] as const,
  ),
  [
    "wakes, steered attempts, failures, stops and rows without a run",
    [
      ...fewUserTurns(5),
      // A wake run has no user message, so its only segment starts at its first row.
      { items: [wake, ...times(200, () => command), ...work(150, 2)] },
      {
        superseded: true,
        items: [
          user(),
          ...times(160, () => ({ ...command, firstAttempt: true as const })),
          { type: "run_interrupt_result", message: "Steered", firstAttempt: true },
          ...times(160, () => command),
          ...work(60, 1),
        ],
      },
      { items: [notice] },
      { items: [user("steer"), ...times(200, () => command), failure, ...work(40, 1)] },
      { status: "rolled_back", items: [user(), ...work(60, 3)] },
      {
        status: "cancelled",
        items: [
          user("queued_turn"),
          { type: "run_interrupt_request", message: "Stop" },
          { type: "run_interrupt_result", message: "Stopped" },
        ],
      },
      {
        items: [
          user("steer", "agent"),
          ...times(150, () => command),
          { ...command, tied: true },
          user("steer"),
          { ...reply, tied: true },
          ...work(140, 2),
        ],
      },
      { items: [wake, ...times(155, () => command), ...work(170, 1)] },
      { status: "queued", items: [user("queued_turn")] },
    ],
  ],
  [
    "a steered segment across the start",
    [...fewUserTurns(4), { items: [user("steer"), ...straddling] }],
  ],
  ["a wake run across the start", [...fewUserTurns(4), { items: [wake, ...straddling] }]],
  [
    "a start at the first row of a run",
    [
      ...fewUserTurns(4),
      { items: [user(), ...times(250, () => reply)] },
      { items: [user(), ...times(249, () => reply)] },
    ],
  ],
  [
    "a start among rows without a run",
    [
      ...fewUserTurns(4),
      { items: times(300, () => notice) },
      { items: [user(), ...times(299, () => reply)] },
    ],
  ],
  [
    "a newest run that failed",
    [
      ...fewUserTurns(14),
      { items: [user(), ...times(200, () => command), failure, ...work(20, 1)] },
    ],
  ],
  ["many wakes after long work", wakeHeavy(14, 60)],
  [
    "a late row of an old run in the tail",
    [
      ...fewUserTurns(16),
      { items: [user("steer"), ...work(30, 2), { ...command, ofRun: 2 }, ...work(10, 2)] },
    ],
  ],
  ["an empty thread", []],
];

describe("the deferred thread window", () => {
  it.effect.each(SHAPES)("is the whole-history window for %s", ([, runs]) =>
    Effect.gen(function* () {
      const { threadId, itemIds } = yield* seedThread("window", runs);
      const read = (options: WindowOptions) => readWindow(threadId, options, () => null);
      const anchors = [0.6, 0.97].flatMap((share) => {
        const id = itemIds[Math.floor(itemIds.length * share)];
        return id === undefined ? [] : [id];
      });
      const options: Array<WindowOptions> = [
        OPEN,
        { ...OPEN, deferWork: false },
        ...[-1, 0, THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT, 700].map((rowLimit) => ({
          ...OPEN,
          rowLimit,
        })),
        ...anchors.map((anchorItemId) => ({
          ...OPEN,
          userTurnLimit: OLDER_THREAD_USER_TURN_LIMIT,
          anchorItemId,
        })),
      ];
      for (const option of options) {
        const whole = yield* readWholeHistoryWindow(threadId, option);
        assert.deepEqual(yield* read(option), whole.window, encodeJson(option));
        if (option === OPEN) {
          assert.strictEqual(
            whole.starts,
            runs.length === 0 ? 0 : 1,
            "statements that find a start",
          );
        }
      }
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect.each(RANDOM_SEEDS)(
    "is the whole-history window for the random thread of seed %s",
    (seed) =>
      Effect.gen(function* () {
        const { threadId, itemIds } = yield* seedThread("random", randomRuns(seed));
        for (const option of [
          OPEN,
          { ...OPEN, rowLimit: 700 },
          ...[0.5, 0.95].map((share) => ({
            ...OPEN,
            userTurnLimit: OLDER_THREAD_USER_TURN_LIMIT,
            anchorItemId: itemIds[Math.floor(itemIds.length * share)]!,
          })),
        ]) {
          const whole = yield* readWholeHistoryWindow(threadId, option);
          const window = yield* readWindow(threadId, option, () => null);
          assert.deepEqual(window, whole.window, encodeJson(option));
        }
      }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("is the whole-history window for a thread forked from a long thread", () =>
    Effect.gen(function* () {
      const source = yield* seedThread("source", fewUserTurns(14));
      const fork = yield* seedThread("fork", [{ items: [user(), ...work(30, 2)] }], {
        forkedFrom: { type: "run", threadId: source.threadId, runId: "run:source:12" },
      });
      for (const option of [OPEN, { ...OPEN, anchorItemId: source.itemIds[2_000]! }]) {
        const whole = yield* readWholeHistoryWindow(fork.threadId, option);
        assert.isAbove(whole.starts, 0);
        const window = yield* readWindow(fork.threadId, option, () => null);
        assert.isNotEmpty(
          window.projection.visibleTurnItems.filter((row) => row.visibility === "inherited"),
        );
        assert.deepEqual(window, whole.window);
      }
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect("groups the same rows however long the history before its newest segments is", () =>
    Effect.gen(function* () {
      // One run steered again and again: its segments, not its first row, bound the grouping.
      const steeredRun = (segments: number): Array<RunSpec> => [
        { items: fewUserTurns(segments).flatMap((run) => run.items) },
      ];
      for (const [name, shape] of [
        ["runs", fewUserTurns],
        ["segments", steeredRun],
      ] as const) {
        const short = yield* seedThread(`short-${name}`, shape(20));
        const long = yield* seedThread(`long-${name}`, shape(40));
        // 502 rows that keep their place span 11 segments of 46.
        const expected = 11 * (long.itemIds.length / 40);
        assert.deepEqual(
          [yield* groupedRows(short.threadId), yield* groupedRows(long.threadId)],
          [expected, expected],
          name,
        );
      }
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect.each([
    ["many wakes", wakeHeavy(14, 60)],
    ["few user turns", fewUserTurns(16)],
    ["many user turns", manyUserTurns(16)],
  ] as const)("finds the start of %s without walking the thread per run", ([, runs]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { threadId } = yield* seedThread("plan", runs);
      const { start, rows } = yield* windowStatements(threadId);
      assert.isDefined(start);
      const planOf = ([query, params]: Compiled) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params)
          .pipe(Effect.map((plan) => plan.map((row) => row.detail)));
      const plan = yield* planOf(start);
      const searches = (details: ReadonlyArray<string>, alias: string) =>
        details.filter((detail) => new RegExp(`^(SEARCH|SCAN) ${alias}\\b`, "u").test(detail));
      const byRun = "INDEX orchestration_v2_projection_turn_items_run_ordinal_idx";
      const runsOfRange =
        "SEARCH member USING COVERING INDEX houston_turn_items_timeline_idx (thread_id=? AND ordinal>? AND ordinal<?)";
      assert.deepEqual(searches(plan, "first"), [
        `SEARCH first USING COVERING ${byRun} (run_id=?)`,
      ]);
      assert.deepEqual(searches(plan, "prompt"), [
        `SEARCH prompt USING ${byRun} (run_id=? AND ordinal<?)`,
      ]);
      assert.deepEqual(searches(plan, "member"), [runsOfRange]);
      assert.deepEqual(searches(yield* planOf(rows), "member"), [runsOfRange]);
      // Every other search of the items is bounded by an ordinal range, a run or a key.
      for (const detail of searches(
        plan,
        "(item|request|orchestration_v2_projection_turn_items)",
      )) {
        assert.match(detail, /ordinal>\? AND ordinal<\?|run_id=\?|turn_item_id=\?|rowid=\?/u);
      }
    }).pipe(Effect.provide(storeLayer)),
  );

  it.effect.each([
    ["many wakes", wakeHeavy(20, 60)],
    ["few user turns", fewUserTurns(20)],
    ["many user turns", manyUserTurns(40)],
  ] as const)("visits no more items than the whole-history read for %s", ([, runs]) =>
    Effect.gen(function* () {
      const { threadId } = yield* seedThread("visits", runs);
      const visits = yield* makeRowCounter;
      const { start, rows } = yield* windowStatements(threadId);
      const whole = yield* readWholeHistoryWindow(threadId, OPEN);
      assert.isDefined(start);
      assert.isDefined(whole.rows);
      const visited = [visits(start), visits(rows)] as const;
      assert.isAtMost(visited[0] + visited[1], visits(whole.rows), visited.join(" + "));
    }).pipe(Effect.scoped, Effect.provide(storeLayer)),
  );

  it.effect.each([
    ["few user turns", fewUserTurns(12)],
    ["many user turns", manyUserTurns(9)],
    [
      "newest segments larger than one window",
      // Ends in a reply: a newest row that folds is also kept on its own, so it is listed twice.
      [...fewUserTurns(3), { items: [user(), ...times(400, () => command), ...work(600, 1)] }],
    ],
  ] as const)(
    "pages back to the oldest item once from the first window of a thread with %s",
    ([, runs]) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const { threadId, itemIds } = yield* seedThread("paging", runs);
        const first = yield* store.getThreadSnapshotWindow(threadId, OPEN);
        const bounded = buildBoundedThreadProjection(first);
        const seen: Array<TurnItemId> = [];
        const collect = Effect.fn("collect")(function* (
          rows: typeof bounded.projection.visibleTurnItems,
        ) {
          for (const row of rows) {
            if (row.item.deferredWork === undefined) {
              seen.push(row.sourceItemId);
              continue;
            }
            let opened = 0;
            let cursor: string | null = row.item.deferredWork.cursor;
            while (cursor !== null) {
              const page: Effect.Success<ReturnType<typeof store.getThreadHistoryPage>> =
                yield* store.getThreadHistoryPage(
                  threadId,
                  cursor,
                  row.sourceItemId,
                  false,
                  "work",
                );
              assert.isNotEmpty(page.items);
              seen.push(...page.items.map((item) => item.sourceItemId));
              opened += page.items.length;
              cursor = page.nextCursor;
            }
            assert.strictEqual(opened, row.item.deferredWork.itemCount);
          }
        });
        yield* collect(bounded.projection.visibleTurnItems);
        assert.isBelow(seen.length, itemIds.length, "the first window is not the whole thread");
        let cursor = bounded.historyCursor;
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, 300);
          const page = yield* store.getThreadHistoryPage(
            threadId,
            cursor,
            undefined,
            false,
            "deferred",
          );
          yield* collect(page.items);
          cursor = page.nextCursor;
        }
        assert.lengthOf(seen, itemIds.length);
        assert.deepEqual(seen.toSorted(), itemIds.toSorted());
      }).pipe(Effect.provide(storeLayer)),
  );
});
