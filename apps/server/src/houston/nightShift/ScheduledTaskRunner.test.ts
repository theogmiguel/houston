// @effect-diagnostics nodeBuiltinImport:off - reads the server's layer sources.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import type { ScheduledTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import {
  awaitTask,
  createProject,
  fireDue,
  kindOf,
  localClock,
  localInstant,
  makeKit,
  makeRepository,
  messageOf,
  nightTask,
  runKit,
  Runner,
  seedNightShift,
  Service,
  Store,
} from "./nightShift.testkit.ts";
import { catchUp, FIXED_TIME_ONLY } from "./ScheduledTaskRunner.ts";

const service = Service.HoustonNightShiftService;

const upsertFrom = (task: ScheduledTask, patch: Partial<ScheduledTask>) =>
  Effect.flatMap(ScheduledTaskService.ScheduledTaskService, (scheduled) =>
    scheduled.upsert({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      enabled: task.enabled,
      schedule: task.schedule as never,
      projectId: task.projectId,
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      ...patch,
    } as never),
  );

const CI = `jobs:
  checks:
    steps:
      - run: pnpm lint
      - run: pnpm test
`;

describe("night shift scheduling", () => {
  it.effect("create stores the defaults and one paused scheduled task", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("create-defaults");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const fixture = makeRepository(
            "defaults",
            { kind: "url", url: "https://github.com/acme/app.git" },
            {
              ".github/workflows/ci.yml": CI,
              "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
              "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
            },
          );
          const projectId = yield* createProject("Acme App", fixture.root);
          const snapshot = yield* night.create({ projectId });

          const { tasks } = yield* scheduled.list();
          assert.lengthOf(tasks, 1);
          const task = tasks[0]!;
          assert.equal(task.title, "Night shift · Acme App");
          assert.deepEqual(task.schedule, { type: "fixed_time", timeOfDay: "23:30", weekdays: [] });
          assert.isFalse(task.enabled);
          assert.equal(task.workspaceStrategy.type, "worktree");
          assert.equal(task.runtimeMode, "full-access");
          assert.equal(task.modelSelection.instanceId, "claudeAgent");
          assert.isNull(task.threadId);

          const stored = (yield* store.settings(projectId))!;
          assert.equal(stored.scheduledTaskId, task.id);
          assert.equal(stored.revision, 1);
          assert.deepEqual(stored.settings.orchestrator, task.modelSelection);
          assert.deepEqual(stored.settings, {
            v: 3,
            enabled: true,
            window: { wrapUp: "06:45", hardStop: "07:30" },
            focus: {
              reliability: "normal",
              performance: "normal",
              uiPolish: "off",
              competitorGaps: "off",
              docsAccuracy: "off",
              testGaps: "off",
            },
            direction: "",
            competitors: [],
            orchestrator: task.modelSelection,
            workers: [task.modelSelection],
            liveWorkers: 4,
            reviewer: null,
            backlog: { enabled: false, max: 3 },
            output: "prs",
            prSize: { kind: "related", maxChanges: 5 },
            screenshots: true,
            appQa: {
              enabled: false,
              startCommand: "pnpm run dev",
              source: "package.json",
              address: null,
              smokeFlows: [],
            },
            holdForQa: true,
            checks: [{ command: "pnpm lint", source: "ci.yml · checks" }],
            verification: "light",
            questions: "park",
          });
          assert.equal(snapshot.schedule?.scheduledTaskId, task.id);
          assert.deepEqual(snapshot.detected.checks, [
            { command: "pnpm lint", source: "ci.yml · checks" },
          ]);
          assert.equal(snapshot.crewCap, 6);
          // No run and no thread.
          assert.lengthOf(snapshot.runs, 0);
          assert.isNull(snapshot.liveRun);
          assert.lengthOf(kit.state.launches, 0);
        }),
      );
    }),
  );

  it.effect("the start time and nights are the scheduled task's", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("task-schedule");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const fixture = makeRepository("schedule", { kind: "bare" });
          const projectId = yield* createProject("schedule", fixture.root);
          const seeded = yield* seedNightShift(projectId);
          // The user edits the start and nights in Scheduled tasks: 23:00 on Saturday (the 31st).
          yield* upsertFrom(seeded, {
            enabled: true,
            schedule: { type: "fixed_time", timeOfDay: "23:00", weekdays: [6] },
          });
          const snapshot = yield* night.get({ projectId });
          assert.equal(snapshot.schedule?.timeOfDay, "23:00");
          assert.deepEqual(snapshot.schedule?.weekdays, [6]);
          assert.equal(localClock(snapshot.schedule!.nextRunAt!), "2026-10-31 23:00");

          const fired = yield* fireDue((yield* nightTask(projectId))!);
          assert.equal(fired?.lastRunStatus, "succeeded", fired?.lastRunError ?? "");
          const runs = yield* store.listRuns(projectId, 30);
          assert.lengthOf(runs, 1);
          assert.equal(runs[0]!.trigger, "scheduled");
          assert.equal(runs[0]!.scheduledTaskId, seeded.id);
          assert.equal(localClock(runs[0]!.startedAt), "2026-10-31 23:00");
          assert.equal(localClock(runs[0]!.wrapUpAt!), "2026-11-01 06:45");
          assert.equal(localClock(runs[0]!.hardStopAt!), "2026-11-01 07:30");
          yield* (yield* Runner.HoustonNightShiftRunner).stop(runs[0]!.id);

          // A fire after the task became an interval schedule starts nothing.
          const current = (yield* nightTask(projectId))!;
          yield* upsertFrom(current, { schedule: { type: "interval", everyMs: 60_000 } });
          const interval = (yield* nightTask(projectId))!;
          yield* TestClock.adjust("2 minutes");
          const refused = yield* awaitTask(interval);
          assert.equal(refused?.lastRunStatus, "failed");
          assert.include(refused?.lastRunError ?? "", FIXED_TIME_ONLY);
          assert.lengthOf(yield* store.listRuns(projectId, 30), 1);
          assert.lengthOf(kit.state.launches, 1);

          // A deleted task: the snapshot shows no schedule and create may run again.
          yield* scheduled.delete({ id: interval.id });
          assert.isNull((yield* night.get({ projectId })).schedule);
          const github = makeRepository("recreate", {
            kind: "url",
            url: "https://github.com/acme/app.git",
          });
          const other = yield* createProject("recreate", github.root);
          yield* night.create({ projectId: other });
          const first = (yield* nightTask(other))!;
          yield* scheduled.delete({ id: first.id });
          assert.isNull((yield* night.get({ projectId: other })).schedule);
          const recreated = yield* night.create({ projectId: other });
          assert.isNotNull(recreated.schedule);
          assert.notEqual(recreated.schedule?.scheduledTaskId, first.id);
        }),
      );
    }),
  );

  it.effect("the server start catches up a missed night once", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("catch-up");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const store = yield* Store.HoustonNightShiftStore;
          const monday = makeRepository("catch-up-monday", { kind: "bare" });
          const wednesday = makeRepository("catch-up-wednesday", { kind: "bare" });
          const onMonday = yield* createProject("catch-up-monday", monday.root);
          const onWednesday = yield* createProject("catch-up-wednesday", wednesday.root);
          yield* seedNightShift(onMonday, {}, { timeOfDay: "23:30", weekdays: [1] });
          yield* seedNightShift(onWednesday, {}, { timeOfDay: "23:30", weekdays: [3] });

          yield* catchUp;
          const runs = yield* store.listRuns(onMonday, 30);
          assert.lengthOf(runs, 1);
          assert.equal(runs[0]!.trigger, "catchUp");
          assert.equal(runs[0]!.phase, "running");
          assert.equal(localClock(runs[0]!.wrapUpAt!), "2026-10-27 06:45");
          assert.equal(localClock(runs[0]!.hardStopAt!), "2026-10-27 07:30");
          assert.lengthOf(yield* store.listRuns(onWednesday, 30), 0);

          // A second start in the same window catches up nothing more.
          yield* catchUp;
          assert.lengthOf(yield* store.listRuns(onMonday, 30), 1);
          assert.lengthOf(kit.state.launches, 1);
        }),
        // Tuesday 02:10, local: Monday's 23:30 start was missed while the server was down.
        localInstant(2026, 10, 27, 2, 10),
      );
    }),
  );
});

describe("startup", () => {
  it.effect("the server and the harness install the night shift runner claim and gate", () =>
    Effect.gen(function* () {
      const source = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
      const count = (text: string, needle: string) => text.split(needle).length - 1;
      const server = source("../../server.ts");
      const runtime = source("../../orchestration-v2/runtimeLayer.ts");
      const kitSource = source("./nightShift.testkit.ts");
      // One runner and claim: the orchestration runtime builds them once and exports them.
      assert.equal(count(runtime, "layerNightShiftRunner"), 2, "imported and provided once");
      assert.equal(count(runtime, "layerHoustonScheduledTaskRunner"), 2, "imported and provided once");
      assert.equal(count(server, "layerNightShift,"), 1, "the service is composed once");
      assert.include(kitSource, "layerHoustonScheduledTaskRunner");
      assert.include(kitSource, "layerClaim");
      // Upstream's scheduled-task tests build the service without the hook and claim nothing.
      const upstreamTest = source("../../scheduledTasks/ScheduledTaskService.test.ts");
      assert.notInclude(upstreamTest, "HoustonScheduledTaskRunner");

      const kit = yield* makeKit("startup-claim");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const fixture = makeRepository("startup", { kind: "bare" });
          const projectId = yield* createProject("startup", fixture.root);
          yield* seedNightShift(projectId);
          const started = yield* night.runNow({ projectId, durationMinutes: 60 });
          // The mapped task was claimed: Night shift launched its orchestrator, upstream did not.
          assert.lengthOf(kit.state.launches, 1);
          const runs = yield* store.listRuns(projectId, 30);
          assert.lengthOf(runs, 1);
          assert.equal(runs[0]!.id, started.runId);
          assert.equal(runs[0]!.trigger, "manual");
          const missing = yield* Effect.flip(night.runNow({ projectId, durationMinutes: 61 }));
          assert.equal(kindOf(missing), "busy");
          assert.include(messageOf(missing), `run ${started.runId}`);
        }),
      );
    }),
  );
});
