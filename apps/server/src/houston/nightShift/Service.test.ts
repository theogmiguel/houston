// @effect-diagnostics nodeBuiltinImport:off - checks run folders on disk.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../../config.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import {
  createProject,
  deleteProject,
  kindOf,
  makeKit,
  makeRepository,
  messageOf,
  nightTask,
  runKit,
  Runner,
  seedNightShift,
  Service,
  sql,
  Store,
} from "./nightShift.testkit.ts";

const service = Service.HoustonNightShiftService;

describe("night shift service", () => {
  it.effect("create refuses a second setup and a project it cannot land in", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("create-refusals");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const github = makeRepository("github", {
            kind: "url",
            url: "https://github.com/acme/app.git",
          });
          const projectId = yield* createProject("github", github.root);
          yield* night.create({ projectId });
          const task = (yield* nightTask(projectId))!;
          const again = yield* Effect.flip(night.create({ projectId }));
          assert.equal(kindOf(again), "conflict");
          assert.include(messageOf(again), task.id);
          assert.lengthOf((yield* scheduled.list()).tasks, 1);

          const plain = makeRepository("plain", null).root;
          NodeFS.rmSync(`${plain}/.git`, { recursive: true, force: true });
          const notGit = yield* createProject("not-git", plain);
          const refusedPath = yield* Effect.flip(night.create({ projectId: notGit }));
          assert.equal(kindOf(refusedPath), "unsupported");
          assert.include(messageOf(refusedPath), plain);

          const gitlab = makeRepository("gitlab", {
            kind: "url",
            url: "git@gitlab.com:acme/app.git",
          });
          const onGitlab = yield* createProject("gitlab", gitlab.root);
          const refusedHost = yield* Effect.flip(night.create({ projectId: onGitlab }));
          assert.equal(kindOf(refusedHost), "unsupported");
          assert.include(messageOf(refusedHost), "gitlab.com");

          // Nothing was created for the refused projects.
          assert.lengthOf((yield* scheduled.list()).tasks, 1);
          const store = yield* Store.HoustonNightShiftStore;
          assert.isUndefined(yield* store.settings(notGit));
          assert.isUndefined(yield* store.settings(onGitlab));
        }),
      );
    }),
  );

  it.effect("update needs the current revision and rewrites the task", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("update-revision");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const github = makeRepository("update", {
            kind: "url",
            url: "https://github.com/acme/app.git",
          });
          const projectId = yield* createProject("update", github.root);
          const created = yield* night.create({ projectId });
          assert.equal(created.revision, 1);
          const task = (yield* nightTask(projectId))!;
          // The user picks Monday and Wednesday in Scheduled tasks.
          yield* scheduled.upsert({
            id: task.id,
            title: task.title,
            prompt: task.prompt,
            enabled: task.enabled,
            schedule: { type: "fixed_time", timeOfDay: "23:30", weekdays: [1, 3] },
            projectId,
            workspaceStrategy: task.workspaceStrategy,
            modelSelection: task.modelSelection,
            runtimeMode: task.runtimeMode,
            interactionMode: task.interactionMode,
          });

          const settings = {
            ...created.settings!,
            orchestrator: { ...created.settings!.orchestrator, instanceId: "codex" as never },
            workers: [{ ...created.settings!.orchestrator, instanceId: "codex" as never }],
            liveWorkers: 6,
          };
          const updated = yield* night.update({ projectId, settings, expectedRevision: 1 });
          assert.equal(updated.revision, 2);
          assert.equal(updated.settings?.liveWorkers, 6);
          const rewritten = (yield* nightTask(projectId))!;
          assert.equal(rewritten.enabled, true, "nights selected and settings enabled");
          assert.deepEqual(rewritten.schedule, {
            type: "fixed_time",
            timeOfDay: "23:30",
            weekdays: [1, 3],
          });
          assert.equal(rewritten.modelSelection.instanceId, "codex");

          // Disabled settings pause the task.
          const paused = yield* night.update({
            projectId,
            settings: { ...settings, enabled: false },
            expectedRevision: 2,
          });
          assert.equal(paused.revision, 3);
          assert.equal((yield* nightTask(projectId))!.enabled, false);

          // A stale revision changes nothing, also while a run is live.
          const store = yield* Store.HoustonNightShiftStore;
          yield* store.openRun({
            projectId,
            trigger: "manual",
            scheduledTaskId: task.id,
            settings,
            startedAt: "2026-10-30T22:00:00.000Z",
            wrapUpAt: "2026-10-30T23:00:00.000Z",
            hardStopAt: "2026-10-30T23:45:00.000Z",
            operation: "runNow",
          });
          const before = yield* nightTask(projectId);
          const stale = yield* Effect.flip(
            night.update({ projectId, settings: { ...settings, liveWorkers: 9 }, expectedRevision: 2 }),
          );
          assert.equal(kindOf(stale), "conflict");
          assert.include(messageOf(stale), "revision 3");
          assert.include(messageOf(stale), "revision 2");
          assert.equal((yield* store.settings(projectId))?.revision, 3);
          assert.equal((yield* store.settings(projectId))?.settings.liveWorkers, 6);
          assert.deepEqual(yield* nightTask(projectId), before);
        }),
      );
    }),
  );

  it.effect("delete and project deletion remove only that project's night shift", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("delete");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const night = yield* service;
          const store = yield* Store.HoustonNightShiftStore;
          const runner = yield* Runner.HoustonNightShiftRunner;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const config = yield* ServerConfig.ServerConfig;
          const db = yield* sql;

          const p = makeRepository("delete-p", { kind: "bare" });
          const q = makeRepository("delete-q", { kind: "bare" });
          const projectP = yield* createProject("delete-p", p.root);
          const projectQ = yield* createProject("delete-q", q.root);
          yield* seedNightShift(projectP);
          yield* seedNightShift(projectQ);
          const runP = yield* runner.start({
            projectId: projectP,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 60,
            operation: "runNow",
          });
          const runQ = yield* runner.start({
            projectId: projectQ,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 60,
            operation: "runNow",
          });
          const folderP = Store.runFolder(config.baseDir, runP.runId);
          const folderQ = Store.runFolder(config.baseDir, runQ.runId);
          assert.isTrue(NodeFS.existsSync(`${folderP}/brief.md`));

          // A live run (and a preflight row) refuses the delete and changes nothing.
          const busy = yield* Effect.flip(night.delete({ projectId: projectP }));
          assert.equal(kindOf(busy), "busy");
          assert.include(messageOf(busy), `run ${runP.runId}`);
          assert.isDefined(yield* store.settings(projectP));
          yield* runner.stop(runP.runId);
          const starting = yield* store.openRun({
            projectId: projectP,
            trigger: "manual",
            scheduledTaskId: null,
            settings: (yield* store.settings(projectP))!.settings,
            startedAt: "2026-10-30T22:30:00.000Z",
            wrapUpAt: "2026-10-30T23:00:00.000Z",
            hardStopAt: "2026-10-30T23:30:00.000Z",
            operation: "runNow",
          });
          const preflightBusy = yield* Effect.flip(night.delete({ projectId: projectP }));
          assert.equal(kindOf(preflightBusy), "busy");
          assert.include(messageOf(preflightBusy), "preflight");
          yield* store.refuse(starting.id, {
            stopReason: null,
            detail: "refused for the test",
            endedAt: "2026-10-30T22:31:00.000Z",
          });
          yield* db`INSERT INTO houston_night_entries (run_id, project_id, kind, title, created_at)
            VALUES (${runP.runId}, ${projectP}, 'lesson', 'P lesson', 'now')`;
          yield* db`INSERT INTO houston_night_entries (run_id, project_id, kind, title, created_at)
            VALUES (${runQ.runId}, ${projectQ}, 'lesson', 'Q lesson', 'now')`;
          yield* db`INSERT INTO houston_night_pushes (run_id, branch, new_sha, at)
            VALUES (${runP.runId}, 't3/p', 'abc', 'now')`;

          const taskP = (yield* nightTask(projectP))!;
          yield* night.delete({ projectId: projectP });
          const count = (table: string, column: string, value: string | number) =>
            db<{ n: number }>`SELECT COUNT(*) AS n FROM ${db(table)} WHERE ${db(column)} = ${value}`.pipe(
              Effect.map((rows) => rows[0]!.n),
            );
          assert.isUndefined(yield* store.settings(projectP));
          assert.equal(yield* count("houston_night_runs", "project_id", projectP), 0);
          assert.equal(yield* count("houston_night_crew", "run_id", runP.runId), 0);
          assert.equal(yield* count("houston_night_entries", "project_id", projectP), 0);
          assert.equal(yield* count("houston_night_pushes", "run_id", runP.runId), 0);
          assert.isFalse(NodeFS.existsSync(folderP));
          assert.isUndefined((yield* scheduled.list()).tasks.find((task) => task.id === taskP.id));
          // Q is untouched.
          assert.isDefined(yield* store.settings(projectQ));
          assert.equal(yield* count("houston_night_entries", "project_id", projectQ), 1);
          assert.isTrue(NodeFS.existsSync(folderQ));

          // Deleting project Q removes its rows and folders; project R's stay.
          const r = makeRepository("delete-r", { kind: "bare" });
          const projectR = yield* createProject("delete-r", r.root);
          yield* seedNightShift(projectR);
          yield* runner.stop(runQ.runId);
          const runR = yield* runner.start({
            projectId: projectR,
            trigger: "manual",
            scheduledTaskId: null,
            durationMinutes: 60,
            operation: "runNow",
          });
          yield* deleteProject(projectQ);
          assert.isUndefined(yield* store.settings(projectQ));
          assert.equal(yield* count("houston_night_runs", "project_id", projectQ), 0);
          assert.equal(yield* count("houston_night_entries", "project_id", projectQ), 0);
          assert.isFalse(NodeFS.existsSync(folderQ));
          assert.isDefined(yield* store.settings(projectR));
          assert.equal(yield* count("houston_night_runs", "project_id", projectR), 1);
          assert.isTrue(NodeFS.existsSync(Store.runFolder(config.baseDir, runR.runId)));
        }),
      );
    }),
  );
});
