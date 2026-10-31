// @effect-diagnostics nodeBuiltinImport:off - builds, holds open and hashes v1 files byte for byte.
// The one-time import of a Houston 1 Slack intake, against v1 databases with v1's final
// `intake_*` tables built in temporary directories on top of the Tasks fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HoustonSlackError } from "@t3tools/contracts/houston/slack";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { makeMemory } from "../secrets/HoustonKeychain.ts";
import { createProject } from "../tasks/tasks.testkit.ts";
import { HoustonTaskV1Import } from "../tasks/V1Import.ts";
import { type V1Fixture, writeV1Database } from "../tasks/v1Fixture.ts";
import { slackTs } from "./rules.ts";
import { HoustonSlackService } from "./Service.ts";
import {
  connectSlack,
  makeFakeRuns,
  reactionEvent,
  runSlack,
  sendEvent,
  storedRequest,
  until,
  untilConnected,
} from "./slack.testkit.ts";
import { HoustonSlackV1Import } from "./V1Import.ts";

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = WINDOWS ? "C:\\work\\shop" : "/work/shop";
const V1_ROOT = WINDOWS ? "c:\\Work\\Shop\\" : "/work/shop";
const OTHER = WINDOWS ? "C:\\work\\gone" : "/work/gone";

// v1's intake tables as `core/houston-core/src/db/intake.rs` leaves them after every migration.
const V1_INTAKE_SCHEMA = `
  CREATE TABLE intake_events (
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
    channel TEXT NOT NULL, ts TEXT NOT NULL, author TEXT NOT NULL, workspace TEXT NOT NULL,
    task_id INTEGER, state TEXT NOT NULL, permalink TEXT, queued_at INTEGER,
    created_at INTEGER NOT NULL, status_reaction TEXT, UNIQUE(source, external_id)
  );
  CREATE TABLE intake_questions (
    id INTEGER PRIMARY KEY, intake_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL, question TEXT NOT NULL, answer TEXT, answered_by TEXT,
    answer_ts TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, delivered_at INTEGER,
    form TEXT
  );
  CREATE TABLE intake_outbox (
    id INTEGER PRIMARY KEY, intake_id INTEGER NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL, reaction TEXT, posted_ts TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER,
    target TEXT NOT NULL DEFAULT 'thread', blocks TEXT, posted_channel TEXT, update_of TEXT,
    message_ts TEXT, remove_reaction TEXT
  );
  CREATE TABLE intake_results (
    run_id INTEGER PRIMARY KEY, intake_id INTEGER NOT NULL, form TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE intake_adjustments (
    id INTEGER PRIMARY KEY, intake_id INTEGER NOT NULL, run_id INTEGER NOT NULL,
    ts TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(intake_id, ts)
  );
`;

const PERMALINK = "https://acme.slack.com/archives/C1/p1700000000000100";

const TASKS: V1Fixture = {
  nextNumber: 3,
  tasks: [
    {
      id: 1,
      workspace: V1_ROOT,
      number: 1,
      title: "Export the report",
      status: "todo",
      createdBy: "slack:U2",
      refUrl: PERMALINK,
      createdAtMs: T0,
    },
    {
      id: 2,
      workspace: V1_ROOT,
      number: 2,
      title: "Rename the file",
      status: "todo",
      createdBy: "slack:U2",
      createdAtMs: T0 + 1,
    },
  ],
  acceptance: [
    { taskId: 1, position: 0, text: "it exports" },
    { taskId: 2, position: 0, text: "it is renamed" },
  ],
  settings: {
    slack_enabled: "1",
    slack_owner: "U1",
    slack_language: "pt_br",
    slack_channels: JSON.stringify([
      { channel_id: "C1", workspace: V1_ROOT },
      { channel_id: "C2", workspace: OTHER },
    ]),
    "slack_cursor:C1": "1700000000.000000",
  },
};

/** The Tasks fixture plus v1's Slack rows: two filed requests and one whose task v2 lacks. */
const writeV1Slack = (file: string, options: { readonly wal?: boolean } = {}) => {
  writeV1Database(file, TASKS, options);
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(V1_INTAKE_SCHEMA);
    const event = db.prepare(
      `INSERT INTO intake_events (id, source, external_id, channel, ts, author, workspace, task_id,
        state, permalink, queued_at, created_at, status_reaction)
       VALUES (?, 'slack', ?, 'C1', ?, 'U2', ?, ?, ?, ?, ?, ?, ?)`,
    );
    event.run(1, "C1:1700000000.000100", "1700000000.000100", V1_ROOT, 1, "pending", PERMALINK, null, T0, "eyes");
    event.run(2, "C1:1700000000.000200", "1700000000.000200", V1_ROOT, 2, "queued", null, T0 + 5, T0 + 1, "eyes");
    event.run(3, "C1:1700000000.000300", "1700000000.000300", V1_ROOT, 99, "pending", null, null, T0 + 2, "eyes");
    db.prepare(
      `INSERT INTO intake_questions (intake_id, run_id, session_id, question, created_at)
       VALUES (1, 1, 1, 'Which format?', ?)`,
    ).run(T0);
    db.prepare(
      "INSERT INTO intake_results (run_id, intake_id, form, created_at) VALUES (1, 1, '{}', ?)",
    ).run(T0);
    db.prepare(
      `INSERT INTO intake_adjustments (intake_id, run_id, ts, text, state, created_at)
       VALUES (1, 1, '1700000001.000100', 'bluer', 'pending', ?)`,
    ).run(T0);
    const outbox = db.prepare(
      "INSERT INTO intake_outbox (intake_id, dedupe_key, text, created_at) VALUES (1, ?, 'x', ?)",
    );
    outbox.run("dm:1", T0);
    outbox.run("seen:1", T0);
  } finally {
    db.close();
  }
};

interface Dirs {
  readonly channel: string;
  readonly baseDir: string;
  readonly source: string;
}

/** A channel directory with a hosted `v2` base dir, removed after the test. */
const withChannel = <A, E>(body: (dirs: Dirs) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-slack-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    return yield* body({ channel, baseDir, source: NodePath.join(channel, "houston.db") });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  const error = Cause.squash((exit as Exit.Failure<A, E>).cause);
  assert.instanceOf(error, HoustonSlackError);
  return error as HoustonSlackError;
};

const hashes = (source: string) =>
  Object.fromEntries(
    ["", "-wal", "-shm"].map((suffix) => {
      const file = `${source}${suffix}`;
      return [
        suffix || "db",
        NodeFS.existsSync(file)
          ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex")
          : "absent",
      ];
    }),
  );

const slackTableCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'houston_slack%'
  `;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(name)}`;
    counts[name] = rows[0]?.n ?? 0;
  }
  return counts;
});

describe("slack import status names each state", () => {
  it.effect("slack import status names each state", () =>
    Effect.gen(function* () {
      // Not hosted: no v1 database can sit beside the base dir.
      yield* runSlack(() =>
        Effect.gen(function* () {
          assert.deepEqual(yield* (yield* HoustonSlackV1Import).status, { state: "unavailable" });
        }),
      );

      // Hosted, without a v1 database.
      yield* withChannel((dirs) =>
        runSlack(
          () =>
            Effect.gen(function* () {
              assert.deepEqual(yield* (yield* HoustonSlackV1Import).status, {
                state: "unavailable",
              });
            }),
          { baseDir: dirs.baseDir },
        ),
      );

      // Hosted beside v1 with Slack rows: blocked until the Tasks import, then available,
      // blocked by a v2 request, and imported after a run.
      yield* withChannel((dirs) =>
        runSlack(
          () =>
            Effect.gen(function* () {
              writeV1Slack(dirs.source);
              yield* createProject("shop", ROOT);
              const imports = yield* HoustonSlackV1Import;
              const before = yield* imports.status;
              assert.strictEqual(before.state, "blocked");
              if (before.state === "blocked") assert.include(before.reason, "Tasks import");
              yield* (yield* HoustonTaskV1Import).run;
              assert.deepEqual(yield* imports.status, {
                state: "available",
                source: dirs.source,
                channels: 2,
                requests: 3,
              });
              const sql = yield* SqlClient.SqlClient;
              yield* sql`
                INSERT INTO houston_slack_requests (channel_id, ts, author, project_id, state, created_at)
                VALUES ('C1', '1700000099.000100', 'U2', 'project-shop', 'refused', '2026-01-02T00:00:00.000Z')
              `;
              const blocked = yield* imports.status;
              assert.strictEqual(blocked.state, "blocked");
              if (blocked.state === "blocked") assert.include(blocked.reason, "1 Slack request");
              yield* sql`DELETE FROM houston_slack_requests`;
              const result = yield* imports.run;
              const after = yield* imports.status;
              assert.strictEqual(after.state, "imported");
              if (after.state === "imported") {
                assert.deepEqual(after.counts, result.imported);
                assert.isTrue(after.at.length > 0);
              }
            }),
          { baseDir: dirs.baseDir },
        ),
      );
    }),
  );
});

describe("v1 intake arrives disabled with its filed requests", () => {
  it.effect("v1 intake arrives disabled with its filed requests", () => {
    const runs = makeFakeRuns();
    const startAtMs = Date.UTC(2026, 9, 31, 12);
    return withChannel((dirs) =>
      runSlack(
        (fake) =>
          Effect.gen(function* () {
            writeV1Slack(dirs.source);
            const projectId = yield* createProject("shop", ROOT);
            yield* (yield* HoustonTaskV1Import).run;
            const result = yield* (yield* HoustonSlackV1Import).run;
            assert.deepEqual(result.imported, { settings: 1, channels: 1, requests: 2 });
            const notes = result.notes.join("\n");
            for (const part of [
              "C2",
              "1700000000.000300",
              "1 question",
              "1 result",
              "1 adjustment",
              "2 outbox",
              "1 cursor",
            ]) {
              assert.include(notes, part);
            }

            const slack = yield* HoustonSlackService;
            const info = yield* slack.get;
            assert.strictEqual(info.enabled, false);
            assert.strictEqual(info.hasTokens, false);
            assert.strictEqual(info.ownerUserId, "U1");
            assert.strictEqual(info.language, "pt-BR");
            assert.deepEqual(info.channels, [{ channelId: "C1", projectId }]);
            const sql = yield* SqlClient.SqlClient;
            const [channel] = yield* sql<{ readonly cursor_ts: string }>`
              SELECT cursor_ts FROM houston_slack_channels WHERE channel_id = 'C1'
            `;
            assert.strictEqual(channel?.cursor_ts, slackTs(startAtMs));
            const pending = yield* storedRequest("1700000000.000100");
            const queued = yield* storedRequest("1700000000.000200");
            assert.deepEqual(
              [pending?.task_id, pending?.state, pending?.status_reaction],
              [1, "pending", "eyes"],
            );
            assert.deepEqual([queued?.task_id, queued?.state], [2, "pending"]);
            const [queuedAt] = yield* sql<{ readonly queued_at: string | null }>`
              SELECT queued_at FROM houston_slack_requests WHERE ts = '1700000000.000200'
            `;
            assert.isNull(queuedAt?.queued_at ?? null);
            assert.isUndefined(yield* storedRequest("1700000000.000300"));

            // The user reconnects once; the owner's ✅ on an imported request starts it.
            yield* connectSlack(projectId, { owner: "U1" });
            yield* untilConnected;
            assert.strictEqual((yield* slack.get).language, "pt-BR");
            yield* sendEvent(fake, reactionEvent("U1", "white_check_mark", "1700000000.000100"));
            yield* until(
              "the imported request started",
              storedRequest("1700000000.000100").pipe(Effect.map((row) => row?.state === "started")),
            );
            assert.deepEqual(runs.starts, ["HOU-1"]);
          }),
        { baseDir: dirs.baseDir, runs, startAtMs },
      ),
    );
  });
});

describe("the slack import reads no keychain, never writes v1, and stores all or nothing", () => {
  it.effect("the slack import reads no keychain, never writes v1, and stores all or nothing", () =>
    Effect.gen(function* () {
      // Another WAL connection holds v1 open with an uncheckpointed write.
      const keychain = makeMemory();
      yield* withChannel((dirs) =>
        runSlack(
          () =>
            Effect.gen(function* () {
              writeV1Slack(dirs.source, { wal: true });
              const daemon = new NodeSqlite.DatabaseSync(dirs.source);
              try {
                daemon.exec("PRAGMA wal_autocheckpoint = 0");
                daemon.prepare("UPDATE settings SET value = 'U1' WHERE key = 'slack_owner'").run();
                daemon.prepare("SELECT COUNT(*) AS n FROM intake_events").get();
                yield* createProject("shop", ROOT);
                const imports = yield* HoustonSlackV1Import;
                // Before the Tasks import: refused by name, nothing stored.
                const early = failureOf(yield* Effect.exit(imports.run));
                assert.strictEqual(early.kind, "invalid");
                assert.include(early.message, "Tasks import");
                yield* (yield* HoustonTaskV1Import).run;
                const before = hashes(dirs.source);
                assert.notStrictEqual(before["-wal"], "absent");
                const calls = keychain.calls.length;
                yield* imports.status;
                const result = yield* imports.run;
                yield* imports.status;
                assert.strictEqual(result.imported.requests, 2);
                assert.strictEqual(keychain.calls.length, calls, "the import reads no keychain");
                assert.deepEqual(hashes(dirs.source), before);
                const again = failureOf(yield* Effect.exit(imports.run));
                assert.strictEqual(again.kind, "invalid");
                assert.include(again.message, "already imported");
              } finally {
                daemon.close();
              }
            }),
          { baseDir: dirs.baseDir, keychain },
        ),
      );

      // v2 rows present.
      yield* withChannel((dirs) =>
        runSlack(
          () =>
            Effect.gen(function* () {
              writeV1Slack(dirs.source);
              const projectId = yield* createProject("shop", ROOT);
              yield* (yield* HoustonTaskV1Import).run;
              yield* (yield* HoustonSlackService).configure({
                channels: [{ channelId: "C7", projectId }],
              });
              const present = failureOf(yield* Effect.exit((yield* HoustonSlackV1Import).run));
              assert.strictEqual(present.kind, "invalid");
              assert.include(present.message, "1 Slack channel");
            }),
          { baseDir: dirs.baseDir },
        ),
      );

      // A row that fails to copy rolls every houston_slack_* table back.
      yield* withChannel((dirs) =>
        runSlack(
          () =>
            Effect.gen(function* () {
              writeV1Slack(dirs.source);
              yield* createProject("shop", ROOT);
              yield* (yield* HoustonTaskV1Import).run;
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe(`
                CREATE TRIGGER houston_test_disk_full BEFORE INSERT ON houston_slack_requests
                WHEN NEW.ts = '1700000000.000200'
                BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
              `);
              const failed = failureOf(yield* Effect.exit((yield* HoustonSlackV1Import).run));
              assert.strictEqual(failed.kind, "unsupported");
              assert.include(failed.message, "database or disk is full");
              const counts = yield* slackTableCounts;
              assert.isTrue(Object.keys(counts).length > 0);
              assert.isTrue(
                Object.values(counts).every((count) => count === 0),
                JSON.stringify(counts),
              );
            }),
          { baseDir: dirs.baseDir },
        ),
      );
    }),
  );
});
