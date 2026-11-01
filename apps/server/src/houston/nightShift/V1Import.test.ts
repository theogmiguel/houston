// @effect-diagnostics nodeBuiltinImport:off - builds v1 databases in temporary channel directories.
// The one-time import of Houston 1's Night shift, from fixture databases beside a hosted base dir.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import {
  NOW,
  Runner,
  Service,
  Store,
  createProject,
  kindOf,
  makeKit,
  makeRepository,
  messageOf,
  runKit,
  seedNightShift,
  sql,
} from "./nightShift.testkit.ts";
import { type V1NightFixture, v1Settings, writeV1NightDatabase } from "./v1Fixture.ts";

const T0 = Date.parse("2026-10-20T22:30:00.000Z");
const HOUR = 3_600_000;

/** A channel directory with a hosted `v2` base dir; v1's houston.db sits beside it. */
const channel = (name: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `houston-night-v1-${name}-`));
  const baseDir = NodePath.join(dir, "v2");
  NodeFS.mkdirSync(baseDir);
  return { dir, baseDir, source: NodePath.join(dir, "houston.db") };
};

const fixtureFor = (workspace: string, other = "/elsewhere/not-a-project"): V1NightFixture => ({
  workspaces: [workspace, other],
  routines: [
    { id: 1, workspace, settings: v1Settings() },
    { id: 2, workspace: other, settings: v1Settings() },
  ],
  runs: [
    {
      runId: 10,
      routineId: 1,
      workspace,
      phase: "settled",
      stopReason: "report",
      startedAtMs: T0,
      endedAtMs: T0 + 8 * HOUR,
      summary: "Two fixes",
    },
    {
      runId: 11,
      routineId: 1,
      workspace,
      phase: "running",
      stopReason: null,
      startedAtMs: T0 + 24 * HOUR,
      endedAtMs: null,
    },
    {
      runId: 12,
      routineId: 2,
      workspace: other,
      phase: "settled",
      stopReason: "report",
      startedAtMs: T0,
      endedAtMs: T0 + HOUR,
    },
  ],
  entries: [
    {
      runId: 10,
      kind: "plan",
      title: "Retry uploads",
      status: "planned",
      createdAtMs: T0 + HOUR,
      detail: { claims: [{ claim: "retries", proof: "test" }] },
    },
    {
      runId: 10,
      kind: "pr",
      title: "Retry uploads",
      theme: "reliability",
      status: "merged",
      prNumber: 41,
      createdAtMs: T0 + 2 * HOUR,
    },
    {
      runId: 10,
      kind: "lesson",
      title: "The sync tests need the fake clock",
      body: "Use TestClock.",
      createdAtMs: T0 + 3 * HOUR,
    },
    {
      runId: 10,
      kind: "flaky",
      title: "e2e flakes",
      detail: { check: "e2e" },
      createdAtMs: T0 + 3 * HOUR,
    },
    {
      runId: 10,
      kind: "deferred",
      title: "Rewrite the parser",
      status: "rejected",
      body: "Too big",
      createdAtMs: T0 + 4 * HOUR,
    },
    {
      runId: 10,
      kind: "studied",
      title: "acme/rival",
      body: "v2.3.0",
      detail: { competitor: "acme/rival", version: "v2.3.0" },
      createdAtMs: T0 + 4 * HOUR,
    },
    {
      runId: 10,
      kind: "decision",
      title: "Drop v1?",
      body: "Keep or drop?",
      choice: "keep",
      decidedAtMs: T0 + 9 * HOUR,
      detail: { options: ["keep", "drop"], recommendation: "keep" },
      createdAtMs: T0 + 5 * HOUR,
    },
    { runId: 11, kind: "lesson", title: "Run lint first", createdAtMs: T0 + 25 * HOUR },
    { runId: 12, kind: "lesson", title: "Elsewhere", createdAtMs: T0 + 2 * HOUR },
  ],
});

const digest = (path: string) =>
  NodeFS.existsSync(path)
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex")
    : "absent";

const fingerprint = (source: string) =>
  ["", "-wal", "-shm"].map((suffix) => digest(`${source}${suffix}`));

const countRows = Effect.gen(function* () {
  const client = yield* sql;
  const [row] = yield* client<{
    readonly settings: number;
    readonly runs: number;
    readonly entries: number;
    readonly imported: number;
  }>`SELECT
      (SELECT COUNT(*) FROM houston_night_shift_settings) AS settings,
      (SELECT COUNT(*) FROM houston_night_runs) AS runs,
      (SELECT COUNT(*) FROM houston_night_entries) AS entries,
      (SELECT COUNT(*) FROM houston_night_import) AS imported`;
  return { settings: row!.settings, runs: row!.runs, entries: row!.entries, import: row!.imported };
});

describe("night shift v1 import", () => {
  it.effect("the import status names why it can or cannot run", () =>
    Effect.gen(function* () {
      // No v1 database: unavailable.
      const empty = channel("status-empty");
      const none = yield* makeKit("v1-status-none", { baseDir: empty.baseDir, hosted: true });
      yield* runKit(
        none,
        Effect.gen(function* () {
          const service = yield* Service.HoustonNightShiftService;
          assert.deepEqual(yield* service.importV1Status({}), { state: "unavailable" });
        }),
      );

      const dirs = channel("status");
      const kit = yield* makeKit("v1-status", { baseDir: dirs.baseDir, hosted: true });
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const service = yield* Service.HoustonNightShiftService;
          const fixture = makeRepository("v1-status", { kind: "bare" });
          const projectId = yield* createProject("v1-status", fixture.root);
          writeV1NightDatabase(dirs.source, fixtureFor(fixture.root));

          const available = yield* service.importV1Status({});
          assert.equal(available.state, "available");
          if (available.state !== "available") return;
          assert.equal(available.source, dirs.source);
          assert.deepEqual(available.workspaces, [
            { path: fixture.root, projectId, runs: 2 },
            { path: "/elsewhere/not-a-project", projectId: null, runs: 1 },
          ]);
          assert.equal(available.runs, 3);

          // v2 already holds Night shift settings: blocked, naming them.
          const other = makeRepository("v1-status-other", { kind: "bare" });
          const otherProject = yield* createProject("v1-status-other", other.root);
          yield* seedNightShift(otherProject);
          const blocked = yield* service.importV1Status({});
          assert.equal(blocked.state, "blocked");
          if (blocked.state === "blocked") assert.include(blocked.reason, otherProject);

          // After an import: imported, with its time and counts.
          yield* (yield* Store.HoustonNightShiftStore).projectRemoved(otherProject);
          yield* service.importV1Run({});
          const imported = yield* service.importV1Status({});
          assert.equal(imported.state, "imported");
          if (imported.state === "imported") {
            assert.isString(imported.at);
            assert.deepEqual(imported.counts, { settings: 1, runs: 2, entries: 8 });
          }
        }),
      );
    }),
  );

  it.effect("the import carries settings and ledgers and drops what v2 cannot run", () =>
    Effect.gen(function* () {
      const dirs = channel("run");
      const kit = yield* makeKit("v1-run", { baseDir: dirs.baseDir, hosted: true });
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const service = yield* Service.HoustonNightShiftService;
          const store = yield* Store.HoustonNightShiftStore;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const runner = yield* Runner.HoustonNightShiftRunner;
          const config = yield* ServerConfig.ServerConfig;
          const fixture = makeRepository("v1-run", { kind: "bare" });
          const projectId = yield* createProject("v1-run", fixture.root);
          writeV1NightDatabase(dirs.source, fixtureFor(fixture.root));
          // v1 still open, with pages only its WAL holds.
          const v1 = new NodeSqlite.DatabaseSync(dirs.source);
          v1.exec("PRAGMA wal_autocheckpoint = 0");
          v1.prepare(
            "INSERT INTO workspaces (path, name, added_at) VALUES ('/late', 'late', 1)",
          ).run();
          const before = fingerprint(dirs.source);
          assert.notEqual(before[1], "absent", "the fixture keeps a WAL");

          const result = yield* service.importV1Run({});
          assert.deepEqual(result.imported, { settings: 1, runs: 2, entries: 8 });
          assert.include(result.notes, "ZCode is not a v2 provider; dropped");
          assert.isTrue(
            result.notes.some((note) => note.includes("/elsewhere/not-a-project")),
            result.notes.join(" | "),
          );
          assert.isTrue(
            result.notes.some((note) => note.includes("Rival")),
            "the app competitor",
          );
          assert.deepEqual(fingerprint(dirs.source), before, "v1's files are unchanged");
          v1.close();

          // Settings: v3, paused, workers mapped to v2 instances.
          const stored = (yield* store.settings(projectId))!;
          assert.equal(stored.settings.v, 3);
          assert.isFalse(stored.settings.enabled);
          assert.deepEqual(stored.settings.workers as unknown, [
            { instanceId: "claudeAgent", model: "opus" },
          ]);
          assert.deepEqual(stored.settings.orchestrator as unknown, {
            instanceId: "claudeAgent",
            model: "opus",
          });
          assert.deepEqual(stored.settings.window, { wrapUp: "06:45", hardStop: "07:30" });
          assert.equal(stored.settings.liveWorkers, 3);
          assert.deepEqual(stored.settings.prSize, { kind: "related", maxChanges: 4 });
          assert.deepEqual(stored.settings.competitors, [{ repo: "acme/rival" }]);
          assert.equal(stored.settings.focus.reliability, "high");
          assert.equal(stored.settings.focus.competitorGaps, "low");
          // The scheduled task: paused, at the v1 start and nights (v1 counts Sunday as 1).
          const task = (yield* scheduled.list()).tasks.find(
            (row) => row.id === stored.scheduledTaskId,
          )!;
          assert.isFalse(task.enabled);
          assert.deepEqual(task.schedule, {
            type: "fixed_time",
            timeOfDay: "23:30",
            weekdays: [1, 3],
          });

          // Runs: settled as imported; the one v1 was running carries the interruption.
          const runs = (yield* store.listRuns(projectId, 10)).toSorted((a, b) => a.id - b.id);
          assert.lengthOf(runs, 2);
          for (const run of runs) {
            assert.equal(run.trigger, "imported");
            assert.equal(run.phase, "settled");
            assert.equal(run.stopReason, "imported");
            assert.isNull(run.reportPath);
          }
          assert.equal(runs[0]!.summary, "Two fixes");
          assert.deepEqual(
            runs[1]!.interruptions.map((item) => item.detail),
            ["imported while running in v1"],
          );
          const kinds = (yield* store.runEntries(runs[0]!.id)).map((row) => row.kind).toSorted();
          assert.deepEqual(kinds, [
            "decision",
            "deferred",
            "flaky",
            "lesson",
            "plan",
            "pr",
            "studied",
          ]);
          const decision = (yield* store.runEntries(runs[0]!.id)).find(
            (row) => row.kind === "decision",
          )!;
          assert.equal(decision.choice, "keep");
          const pr = (yield* store.runEntries(runs[0]!.id)).find((row) => row.kind === "pr")!;
          assert.equal(pr.pr_number, 41);
          assert.equal(pr.status, "merged");

          // The next brief of the project carries the imported ledger.
          const started = yield* runner.start({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 120,
            operation: "runNow",
          });
          const brief = NodeFS.readFileSync(
            NodePath.join(Store.runFolder(config.baseDir, started.runId), "brief.md"),
            "utf8",
          );
          assert.include(brief, "The sync tests need the fake clock");
          assert.include(brief, "Run lint first");
          assert.include(brief, `decision answered "keep": Drop v1?`);
          assert.notInclude(brief, "Elsewhere");
        }),
        NOW,
      );
    }),
  );

  it.effect("the import refuses by name and changes nothing", () =>
    Effect.gen(function* () {
      // No v1 database: not_found.
      const empty = channel("refuse-empty");
      const none = yield* makeKit("v1-refuse-none", { baseDir: empty.baseDir, hosted: true });
      yield* runKit(
        none,
        Effect.gen(function* () {
          const service = yield* Service.HoustonNightShiftService;
          const missing = yield* Effect.flip(service.importV1Run({}));
          assert.equal(kindOf(missing), "not_found");
          assert.include(messageOf(missing), "houston.db");
          assert.deepEqual(yield* countRows, { settings: 0, runs: 0, entries: 0, import: 0 });
        }),
      );

      const dirs = channel("refuse");
      const kit = yield* makeKit("v1-refuse", { baseDir: dirs.baseDir, hosted: true });
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const service = yield* Service.HoustonNightShiftService;
          const store = yield* Store.HoustonNightShiftStore;
          const fixture = makeRepository("v1-refuse", { kind: "bare" });
          const projectId = yield* createProject("v1-refuse", fixture.root);
          writeV1NightDatabase(dirs.source, fixtureFor(fixture.root));

          // A v2 run present: conflict, naming it.
          yield* seedNightShift(projectId);
          const settings = (yield* store.settings(projectId))!.settings;
          const run = yield* store.openRun({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            settings,
            startedAt: NOW,
            wrapUpAt: NOW,
            hardStopAt: NOW,
            operation: "test",
          });
          yield* store.refuse(run.id, { stopReason: null, detail: "test", endedAt: NOW });
          const withRun = yield* countRows;
          const busy = yield* Effect.flip(service.importV1Run({}));
          assert.equal(kindOf(busy), "conflict");
          assert.include(messageOf(busy), projectId);
          assert.deepEqual(yield* countRows, withRun);

          // After an import, a second one: conflict.
          yield* store.projectRemoved(projectId);
          yield* service.importV1Run({});
          const after = yield* countRows;
          const again = yield* Effect.flip(service.importV1Run({}));
          assert.equal(kindOf(again), "conflict");
          assert.include(messageOf(again), "imported");
          assert.deepEqual(yield* countRows, after);
        }),
      );
    }),
  );
});
