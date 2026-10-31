// @effect-diagnostics nodeBuiltinImport:off globalDate:off - hashes and corrupts v1 files byte for byte.
// The one-time import of a Houston 1 backlog, against v1 databases built in temporary directories.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HoustonTaskError, type HoustonTaskRunState } from "@t3tools/contracts/houston/tasks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import * as HoustonTaskService from "./TaskService.ts";
import * as HoustonTaskV1Import from "./V1Import.ts";
import { createProject, layerTasks } from "./tasks.testkit.ts";
import { type V1Fixture, writeV1Database } from "./v1Fixture.ts";

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const iso = (ms: number) => new Date(ms).toISOString();
const WINDOWS = HostProcess.Platform.defaultValue() === "win32";
const ROOT = WINDOWS ? "C:\\work\\shop" : "/work/shop";
// The path v1 recorded: on Windows another case and a trailing separator, as a user typed it.
const V1_ROOT = WINDOWS ? "c:\\Work\\Shop\\" : "/work/shop";
const OTHER = WINDOWS ? "C:\\work\\gone" : "/work/gone";

interface Dirs {
  /** The channel directory: v1's houston.db sits here. */
  readonly channel: string;
  /** The hosted v2 base dir, `<channel>/v2`. */
  readonly baseDir: string;
  readonly source: string;
}

/** A channel directory with a hosted `v2` base dir, removed after the test. */
const withChannel = <A, E, R>(body: (dirs: Dirs) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const channel = yield* fs.makeTempDirectoryScoped({ prefix: "houston-v1-import-" });
    const baseDir = NodePath.join(channel, "v2");
    NodeFS.mkdirSync(baseDir);
    return yield* body({ channel, baseDir, source: NodePath.join(channel, "houston.db") });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit), "expected a refusal");
  const error = Cause.squash((exit as Exit.Failure<A, E>).cause);
  assert.instanceOf(error, HoustonTaskError);
  return error as HoustonTaskError;
};

const importer = HoustonTaskV1Import.HoustonTaskV1Import;
const service = HoustonTaskService.HoustonTaskService;

const simpleFixture = (workspace: string | null = null): V1Fixture => ({
  nextNumber: 3,
  tasks: [
    { id: 1, workspace, number: 1, title: "one", status: "todo", createdAtMs: T0 },
    { id: 2, workspace, number: 2, title: "two", status: "backlog", createdAtMs: T0 + 1 },
  ],
});

const houstonTableCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'houston_task%'
      AND name != 'houston_task_counter'
  `;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(name)}`;
    counts[name] = rows[0]?.n ?? 0;
  }
  return counts;
});

describe("import status names each state", () => {
  it.effect("available beside a v1 database, then imported after a run", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, simpleFixture());
        const imports = yield* importer;
        assert.deepEqual(yield* imports.status, {
          state: "available",
          source: dirs.source,
          taskCount: 2,
        });
        const result = yield* imports.run;
        assert.strictEqual(result.imported.tasks, 2);
        const status = yield* imports.status;
        assert.strictEqual(status.state, "imported");
        if (status.state === "imported") {
          assert.deepEqual(status.counts, result.imported);
          assert.isTrue(status.at.length > 0);
        }
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("blocked while the v2 backlog holds a task", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, simpleFixture());
        yield* (yield* service).save({ patch: { title: "made in v2" } });
        assert.deepEqual(yield* (yield* importer).status, { state: "blocked", taskCount: 1 });
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("unavailable with no v1 database beside the base dir", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* (yield* importer).status, { state: "unavailable" });
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("unavailable when the server is not hosted, even in a base dir named v2", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        // A v1 database sits beside the base dir, but no host launched this server.
        writeV1Database(dirs.source, simpleFixture());
        const imports = yield* importer;
        assert.deepEqual(yield* imports.status, { state: "unavailable" });
        const refused = failureOf(yield* Effect.exit(imports.run));
        assert.strictEqual(refused.kind, "unsupported");
        assert.include(refused.message, "not hosted");
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir, hosted: false }))),
    ),
  );

  it.effect("unavailable when the v1 file has no backlog table", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        const db = new NodeSqlite.DatabaseSync(dirs.source);
        db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.close();
        assert.deepEqual(yield* (yield* importer).status, { state: "unavailable" });
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

const fullFixture: V1Fixture = {
  nextNumber: 7,
  tasks: [
    {
      id: 10,
      workspace: V1_ROOT,
      number: 1,
      title: "Delivery",
      description: "the whole thing",
      status: "in_progress",
      priority: 2,
      refUrl: "https://tracker.test/1",
      revision: 4,
      createdBy: "user",
      createdAtMs: T0,
      updatedAtMs: T0 + 100,
    },
    {
      id: 11,
      workspace: V1_ROOT,
      number: 2,
      title: "Slice",
      status: "done",
      priority: 1,
      parentId: 10,
      revision: 2,
      createdBy: "agent:Nova (operator)",
      createdAtMs: T0 + 1,
      updatedAtMs: T0 + 200,
    },
    {
      id: 12,
      workspace: OTHER,
      number: 5,
      title: "Archived elsewhere",
      status: "canceled",
      priority: 4,
      revision: 3,
      createdAtMs: T0 + 2,
      updatedAtMs: T0 + 300,
      archivedAtMs: T0 + 300,
    },
  ],
  acceptance: [
    { taskId: 10, position: 0, text: "it ships", checkedAtMs: T0 + 50, checkedBy: "user" },
    { taskId: 10, position: 1, text: "it is fast" },
  ],
  comments: [
    { taskId: 10, body: "first note", author: "user", createdAtMs: T0 + 10 },
    { taskId: 10, body: "agent note", author: "agent:Nova (operator)", createdAtMs: T0 + 20 },
  ],
  history: [
    { taskId: 10, actor: "user", action: "create", changes: "{}", createdAtMs: T0 },
    {
      taskId: 12,
      actor: "houston:renumbered",
      action: "houston:renumbered",
      changes: '{"key":{"old":"HOU-1","new":"HOU-5"}}',
      createdAtMs: T0 + 5,
    },
  ],
  blocks: [{ taskId: 11, blockedById: 12 }],
  projects: [
    {
      id: 3,
      workspace: V1_ROOT,
      name: "Storefront",
      externalUrl: "https://tracker.test/p/3",
      trackerDescription: "tracker text",
      localDecisions: ["use the old API"],
      revision: 2,
      updatedAtMs: T0,
    },
  ],
  domains: [
    {
      taskId: 10,
      kind: "delivery",
      projectId: 3,
      userStatusOverride: true,
      planJson: JSON.stringify({
        revision: 2,
        proposal: {
          description: "planned",
          acceptance: ["a"],
          pointers: ["src/a.ts"],
          out_of_scope: ["b"],
          questions: ["which API?"],
        },
        answers: [{ question: "which API?", answer: "the old one" }],
        approved_revision: 4,
      }),
      planRevision: 2,
      approvedTaskRevision: 4,
    },
    { taskId: 11, kind: "slice" },
  ],
};

describe("an import keeps every key, row and the counter", () => {
  it.effect("HOU-1, HOU-2 and HOU-5 keep their fields; the next task is HOU-7", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, fullFixture);
        const project = yield* createProject("shop", ROOT);
        const tasks = yield* service;
        const result = yield* (yield* importer).run;
        assert.deepEqual(result.imported, {
          tasks: 3,
          acceptance: 2,
          comments: 2,
          history: 2,
          blockers: 1,
          domains: 2,
          initiatives: 1,
          runs: 0,
          settings: 0,
        });

        const delivery = yield* tasks.get({ id: "HOU-1" });
        assert.deepInclude(delivery.task, {
          id: 10,
          number: 1,
          key: "HOU-1",
          projectId: project,
          title: "Delivery",
          description: "the whole thing",
          status: "in_progress",
          priority: "high",
          parentId: null,
          refUrl: "https://tracker.test/1",
          revision: 4,
          createdBy: "user",
          createdAt: iso(T0),
          updatedAt: iso(T0 + 100),
          archivedAt: null,
        });
        assert.deepEqual(
          delivery.acceptance.map((item) => [item.text, item.checkedAt, item.checkedBy]),
          [
            ["it ships", iso(T0 + 50), "user"],
            ["it is fast", null, null],
          ],
        );
        assert.deepEqual(
          delivery.comments.map((comment) => [comment.body, comment.author, comment.createdAt]),
          [
            ["first note", "user", iso(T0 + 10)],
            ["agent note", "agent:Nova (operator)", iso(T0 + 20)],
          ],
        );
        assert.deepEqual(
          delivery.history.map((row) => [row.actor, row.action]),
          [
            ["houston:imported", "houston:imported"],
            ["user", "create"],
          ],
        );
        assert.strictEqual(delivery.domain.kind, "delivery");
        assert.strictEqual(delivery.domain.initiativeId, 3);
        assert.deepEqual(delivery.domain.plan, {
          revision: 2,
          proposal: {
            description: "planned",
            acceptance: ["a"],
            pointers: ["src/a.ts"],
            outOfScope: ["b"],
            questions: ["which API?"],
          },
          answers: [{ question: "which API?", answer: "the old one" }],
          approvedRevision: 4,
        });

        const slice = yield* tasks.get({ id: "hou-2" });
        assert.deepInclude(slice.task, {
          id: 11,
          status: "done",
          priority: "urgent",
          parentId: 10,
          createdBy: "agent:Nova (operator)",
        });
        assert.strictEqual(slice.domain.kind, "slice");
        assert.deepEqual(slice.domain.blockedBy, [12]);

        const archived = yield* tasks.get({ id: "HOU-5" });
        assert.deepInclude(archived.task, {
          id: 12,
          projectId: null,
          status: "canceled",
          priority: "low",
          revision: 3,
          archivedAt: iso(T0 + 300),
        });
        const renumbered = archived.history.find((row) => row.action === "houston:renumbered");
        assert.deepEqual(renumbered, {
          id: renumbered?.id ?? -1,
          actor: "houston:renumbered",
          action: "houston:renumbered",
          changes: '{"key":{"old":"HOU-1","new":"HOU-5"}}',
          createdAt: iso(T0 + 5),
        });
        const importedRows = [delivery, slice, archived].map(
          (detail) => detail.history.filter((row) => row.action === "houston:imported").length,
        );
        assert.deepEqual(importedRows, [1, 1, 1]);

        const [initiative] = yield* tasks.listInitiatives({ projectId: project });
        assert.deepInclude(initiative, {
          id: 3,
          projectId: project,
          name: "Storefront",
          externalUrl: "https://tracker.test/p/3",
          trackerDescription: "tracker text",
          revision: 2,
          archivedAt: null,
        });
        assert.deepEqual(initiative?.localDecisions, ["use the old API"]);

        const next = yield* tasks.save({ patch: { title: "first v2 task" } });
        assert.strictEqual(next.key, "HOU-7");
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("a counter behind the highest number continues past it", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          nextNumber: 2,
          tasks: [
            { id: 1, workspace: null, number: 9, title: "high", status: "todo", createdAtMs: T0 },
          ],
        });
        yield* (yield* importer).run;
        assert.strictEqual(
          (yield* (yield* service).save({ patch: { title: "next" } })).key,
          "HOU-10",
        );
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("v1 workspaces map to projects by their root", () => {
  it.effect("a matching root assigns the project; an unmatched path is named in history", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          nextNumber: 3,
          tasks: [
            {
              id: 1,
              workspace: V1_ROOT,
              number: 1,
              title: "matched",
              status: "todo",
              createdAtMs: T0,
            },
            {
              id: 2,
              workspace: OTHER,
              number: 2,
              title: "unmatched",
              status: "todo",
              createdAtMs: T0,
            },
          ],
        });
        const project = yield* createProject("shop", ROOT);
        const tasks = yield* service;
        yield* (yield* importer).run;
        assert.strictEqual((yield* tasks.get({ id: "HOU-1" })).task.projectId, project);
        const unmatched = yield* tasks.get({ id: "HOU-2" });
        assert.isNull(unmatched.task.projectId);
        const imported = unmatched.history.find((row) => row.action === "houston:imported");
        assert.include(JSON.parse(imported?.changes ?? "{}").workspace, OTHER);
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("live v1 runs arrive interrupted", () => {
  const STATES: ReadonlyArray<HoustonTaskRunState> = [
    "preparing",
    "running",
    "waiting_for_input",
    "validating",
    "handed_back",
    "needs_review",
    "failed",
    "cancelled",
    "interrupted",
  ];
  const OPEN = new Set(["preparing", "running", "waiting_for_input", "validating"]);

  it.effect("open runs are interrupted; finished runs keep their fields; none has a thread", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          nextNumber: 10,
          tasks: STATES.map((_, index) => ({
            id: index + 1,
            workspace: null,
            number: index + 1,
            title: `run ${index + 1}`,
            status: "in_progress",
            createdAtMs: T0,
          })),
          runs: STATES.map((state, index) => ({
            id: 100 + index,
            taskId: index + 1,
            attempt: 1,
            kind: "implementation" as const,
            state,
            provider: "codex",
            reviewer: "claude",
            sessionId: 40 + index,
            worktreePath: `/wt/${index}`,
            branch: `houston/task-${index}`,
            baseCommit: "abc123",
            initialRevision: 1,
            summary: `summary ${index}`,
            reason: state === "interrupted" ? "the pane exited" : null,
            startedAtMs: T0 + index,
            endedAtMs: OPEN.has(state) ? null : T0 + 1000,
            prUrl: `https://github.test/pr/${index}`,
            reviewHeadSha: "f".repeat(40),
            reviewFocus: "bugs",
            reviewVerdict: "fail",
            reviewFindings: "[]",
          })),
        });
        const tasks = yield* service;
        const result = yield* (yield* importer).run;
        assert.strictEqual(result.imported.runs, 9);
        for (const [index, state] of STATES.entries()) {
          const [run] = (yield* tasks.get({ id: `HOU-${index + 1}` })).runs;
          assert.isDefined(run, state);
          assert.isNull(run?.threadId);
          assert.isNull(run?.runId);
          assert.strictEqual(run?.branch, `houston/task-${index}`, state);
          assert.strictEqual(run?.worktreePath, `/wt/${index}`, state);
          assert.strictEqual(run?.prUrl, `https://github.test/pr/${index}`, state);
          assert.strictEqual(run?.summary, `summary ${index}`, state);
          assert.strictEqual(run?.provider, "codex");
          assert.strictEqual(run?.review?.verdict, "fail", state);
          if (OPEN.has(state)) {
            assert.strictEqual(run?.state, "interrupted", state);
            assert.strictEqual(run?.reason, "imported from Houston 1", state);
            assert.isNotNull(run?.endedAt, state);
          } else {
            assert.strictEqual(run?.state, state);
            assert.strictEqual(run?.endedAt, iso(T0 + 1000), state);
          }
        }
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("v1 settings follow matched workspaces", () => {
  it.effect("each of the seven prefixes becomes the project's setting; others are dropped", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          ...simpleFixture(V1_ROOT),
          settings: {
            [`tasks_access:${V1_ROOT}`]: "read",
            [`tasks_start_agent:${V1_ROOT}`]: "codex",
            [`tasks_prompt_delivery:${V1_ROOT}`]: "prefill",
            [`tasks_default_reviewer:${V1_ROOT}`]: "claude",
            [`tasks_rework_rounds:${V1_ROOT}`]: "3",
            [`tasks_review_mode:${V1_ROOT}`]: "every_push",
            [`tasks_review_focus:${V1_ROOT}`]: "performance",
            [`tasks_access:${OTHER}`]: "off",
            [`tasks_rework_rounds:${OTHER}`]: "5",
            unrelated_setting: "x",
          },
        });
        const project = yield* createProject("shop", ROOT);
        const other = yield* createProject("other", WINDOWS ? "C:\\work\\other" : "/work/other");
        const tasks = yield* service;
        const result = yield* (yield* importer).run;
        assert.strictEqual(result.imported.settings, 1);
        assert.deepEqual(yield* tasks.getSettings({ projectId: project }), {
          access: "read",
          startModel: { instanceId: "codex", model: "gpt-6-astra" },
          delivery: "prefill",
          reviewer: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          reviewMode: "every_push",
          focus: "performance",
          reworkRounds: 3,
        } as never);
        assert.strictEqual((yield* tasks.getSettings({ projectId: other })).access, "write");
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("unmapped v1 agents are reported", () => {
  it.effect("each agent v2 cannot run is named with the choice made instead", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        const SECOND = WINDOWS ? "C:\\work\\second" : "/work/second";
        writeV1Database(dirs.source, {
          ...simpleFixture(V1_ROOT),
          settings: {
            [`tasks_start_agent:${V1_ROOT}`]: "antigravity",
            [`tasks_default_reviewer:${V1_ROOT}`]: "zcode",
            [`tasks_review_mode:${V1_ROOT}`]: "every_push",
            [`tasks_start_agent:${SECOND}`]: "codex",
            [`tasks_default_reviewer:${SECOND}`]: "cursor",
          },
        });
        const project = yield* createProject("shop", ROOT);
        const second = yield* createProject("second", SECOND);
        const tasks = yield* service;
        const result = yield* (yield* importer).run;
        const shop = yield* tasks.getSettings({ projectId: project });
        assert.deepEqual(shop.startModel, {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
        } as never);
        assert.isNull(shop.reviewer);
        // A review mode without a reviewer is turned off, never kept reviewer-less.
        assert.strictEqual(shop.reviewMode, "manual");
        const other = yield* tasks.getSettings({ projectId: second });
        assert.deepEqual(other.startModel, { instanceId: "codex", model: "gpt-6-astra" } as never);
        assert.isNull(other.reviewer);
        assert.strictEqual(other.reviewMode, "manual");
        assert.sameMembers(
          [...result.notes],
          [
            `${project}: start agent antigravity has no v2 driver; chose claudeAgent claude-opus-5-5`,
            `${project}: reviewer zcode has no v2 driver; chose no reviewer`,
            `${project}: review mode every_push needs a reviewer; chose manual`,
            `${second}: reviewer cursor has no v2 driver; chose no reviewer`,
          ],
        );
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

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

describe("the v1 database is never written", () => {
  it.effect(
    "another WAL connection holds an uncheckpointed write; every file hashes the same",
    () =>
      withChannel((dirs) =>
        Effect.gen(function* () {
          writeV1Database(dirs.source, simpleFixture(), { wal: true });
          // The running v1 daemon: an open connection with a committed, uncheckpointed write.
          const daemon = new NodeSqlite.DatabaseSync(dirs.source);
          try {
            daemon.exec("PRAGMA wal_autocheckpoint = 0");
            daemon
              .prepare(
                `INSERT INTO backlog_tasks (id, workspace, number, title, status, created_by,
                 created_at, updated_at) VALUES (3, NULL, 3, 'in the wal', 'todo', 'user', ?, ?)`,
              )
              .run(T0, T0);
            daemon.prepare("SELECT COUNT(*) AS n FROM backlog_tasks").get();
            const before = hashes(dirs.source);
            assert.notStrictEqual(before["-wal"], "absent");
            const result = yield* (yield* importer).run;
            assert.strictEqual(result.imported.tasks, 3);
            assert.strictEqual(
              (yield* (yield* service).get({ id: "HOU-3" })).task.title,
              "in the wal",
            );
            assert.deepEqual(hashes(dirs.source), before);
          } finally {
            daemon.close();
          }
        }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
      ),
  );

  it.effect("a cleanly closed WAL database gets no -wal or -shm beside it", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        // v1 has stopped: its WAL database was checkpointed and closed, leaving only the file.
        writeV1Database(dirs.source, simpleFixture(), { wal: true });
        const listing = () => NodeFS.readdirSync(dirs.channel).toSorted();
        const before = { files: listing(), hashes: hashes(dirs.source) };
        assert.deepEqual(before.files, ["houston.db", "v2"]);
        const imports = yield* importer;
        assert.strictEqual((yield* imports.status).state, "available");
        const result = yield* imports.run;
        assert.strictEqual(result.imported.tasks, 2);
        yield* imports.status;
        assert.deepEqual({ files: listing(), hashes: hashes(dirs.source) }, before);
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("an import into a non-empty backlog is refused", () => {
  it.effect("a v2 task, an earlier import and a missing source are each refused by name", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, simpleFixture());
        const imports = yield* importer;
        const tasks = yield* service;
        const v2Task = yield* tasks.save({ patch: { title: "made in v2" } });
        const nonEmpty = failureOf(yield* Effect.exit(imports.run));
        assert.strictEqual(nonEmpty.kind, "invalid");
        assert.include(nonEmpty.message, "1 task");

        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM houston_task_history WHERE task_id = ${v2Task.id}`;
        yield* sql`DELETE FROM houston_tasks WHERE id = ${v2Task.id}`;
        yield* sql`UPDATE houston_task_counter SET next_number = 1 WHERE id = 1`;
        yield* imports.run;
        const status = yield* imports.status;
        const again = failureOf(yield* Effect.exit(imports.run));
        assert.strictEqual(again.kind, "invalid");
        if (status.state === "imported") assert.include(again.message, status.at);
        else assert.fail(`expected imported, got ${status.state}`);
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("a v2 setting wins over v1's and is reported; status and run agree", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          ...simpleFixture(V1_ROOT),
          settings: {
            [`tasks_access:${V1_ROOT}`]: "read",
            [`tasks_rework_rounds:${V1_ROOT}`]: "3",
          },
        });
        const project = yield* createProject("shop", ROOT);
        const tasks = yield* service;
        const imports = yield* importer;
        const chosen = yield* tasks.setSettings({
          projectId: project,
          settings: {
            access: "off",
            startModel: { instanceId: "codex", model: "gpt-6-astra" },
            delivery: "prefill",
            reviewer: null,
            focus: "security",
            reworkRounds: 1,
          } as never,
        });
        assert.strictEqual((yield* imports.status).state, "available");
        const result = yield* imports.run;
        assert.strictEqual(result.imported.tasks, 2);
        assert.strictEqual(result.imported.settings, 0);
        assert.deepEqual(yield* tasks.getSettings({ projectId: project }), chosen);
        assert.include(
          result.notes,
          `${project}: settings set in v2 kept; Houston 1's tasks_access, tasks_rework_rounds dropped`,
        );
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("a v1 initiative whose id is taken gets a fresh id; its tasks follow it", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          nextNumber: 3,
          tasks: [
            { id: 1, workspace: V1_ROOT, number: 1, title: "d", status: "todo", createdAtMs: T0 },
            { id: 2, workspace: V1_ROOT, number: 2, title: "e", status: "todo", createdAtMs: T0 },
          ],
          projects: [
            { id: 1, workspace: V1_ROOT, name: "v1 first", updatedAtMs: T0 },
            { id: 2, workspace: V1_ROOT, name: "v1 second", updatedAtMs: T0 },
          ],
          domains: [
            { taskId: 1, kind: "delivery", projectId: 1 },
            { taskId: 2, kind: "delivery", projectId: 2 },
          ],
        });
        const project = yield* createProject("shop", ROOT);
        const tasks = yield* service;
        const imports = yield* importer;
        const v2 = yield* tasks.saveInitiative({ projectId: project, name: "made in v2" });
        assert.strictEqual(v2.id, 1);
        assert.strictEqual((yield* imports.status).state, "available");
        const result = yield* imports.run;
        assert.strictEqual(result.imported.initiatives, 2);
        const listed = yield* tasks.listInitiatives({ projectId: project });
        const byName = new Map(listed.map((initiative) => [initiative.name, initiative.id]));
        assert.strictEqual(byName.get("made in v2"), 1);
        assert.strictEqual(byName.get("v1 second"), 2);
        const remapped = byName.get("v1 first");
        assert.isDefined(remapped);
        assert.notInclude([1, 2], remapped);
        assert.strictEqual((yield* tasks.get({ id: "HOU-1" })).domain.initiativeId, remapped);
        assert.strictEqual((yield* tasks.get({ id: "HOU-2" })).domain.initiativeId, 2);
        assert.include(
          result.notes,
          `initiative 1 "v1 first" was taken in v2; imported as ${remapped}`,
        );
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("a row that fails to copy is named by its table and row", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          ...simpleFixture(),
          comments: [
            { taskId: 1, body: "fine", author: "user", createdAtMs: T0 },
            { taskId: 2, body: "the disk fills here", author: "user", createdAtMs: T0 },
          ],
        });
        // The disk fills while the second comment is written.
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`
          CREATE TRIGGER houston_test_disk_full BEFORE INSERT ON houston_task_comments
          WHEN NEW.body = 'the disk fills here'
          BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
        `);
        const error = failureOf(yield* Effect.exit((yield* importer).run));
        assert.strictEqual(error.kind, "unsupported");
        assert.include(error.message, "houston_task_comments");
        assert.include(error.message, "row 2");
        assert.include(error.message, "database or disk is full");
        const counts = yield* houstonTableCounts;
        assert.isTrue(
          Object.values(counts).every((count) => count === 0),
          JSON.stringify(counts),
        );
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );

  it.effect("no source is unsupported", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        const missing = failureOf(yield* Effect.exit((yield* importer).run));
        assert.strictEqual(missing.kind, "unsupported");
        assert.include(missing.message, dirs.source);
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});

describe("a failed import stores nothing", () => {
  it.effect(
    "a v1 file corrupt at its last page is unsupported and every v2 table stays empty",
    () =>
      withChannel((dirs) =>
        Effect.gen(function* () {
          writeV1Database(dirs.source, {
            ...simpleFixture(),
            comments: Array.from({ length: 200 }, (_, index) => ({
              taskId: 1,
              body: `comment ${index} ${"x".repeat(200)}`,
              author: "user",
              createdAtMs: T0 + index,
            })),
          });
          const pageSize = 4096;
          const size = NodeFS.statSync(dirs.source).size;
          const fd = NodeFS.openSync(dirs.source, "r+");
          NodeFS.writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, size - pageSize);
          NodeFS.closeSync(fd);

          const error = failureOf(yield* Effect.exit((yield* importer).run));
          assert.strictEqual(error.kind, "unsupported");
          assert.include(error.message, dirs.source);
          assert.match(error.message, /malformed|corrupt/i);
          const counts = yield* houstonTableCounts;
          assert.isTrue(Object.keys(counts).length > 0);
          assert.isTrue(
            Object.values(counts).every((count) => count === 0),
            JSON.stringify(counts),
          );
        }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
      ),
  );

  it.effect("a row that fails to copy rolls the whole import back", () =>
    withChannel((dirs) =>
      Effect.gen(function* () {
        writeV1Database(dirs.source, {
          nextNumber: 3,
          tasks: [
            { id: 1, workspace: null, number: 1, title: "fine", status: "todo", createdAtMs: T0 },
            {
              id: 2,
              workspace: null,
              number: 2,
              title: "bad",
              status: "exploded",
              createdAtMs: T0,
            },
          ],
        });
        const error = failureOf(yield* Effect.exit((yield* importer).run));
        assert.strictEqual(error.kind, "unsupported");
        assert.include(error.message, "exploded");
        const counts = yield* houstonTableCounts;
        assert.isTrue(
          Object.values(counts).every((count) => count === 0),
          JSON.stringify(counts),
        );
        assert.strictEqual((yield* (yield* importer).status).state, "available");
      }).pipe(Effect.provide(layerTasks({ baseDir: dirs.baseDir }))),
    ),
  );
});
