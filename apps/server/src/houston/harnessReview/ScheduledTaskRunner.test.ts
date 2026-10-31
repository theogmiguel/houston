// @effect-diagnostics nodeBuiltinImport:off - reads the server's layer sources.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type ScheduledTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import {
  awaitRun,
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  makeKit,
  model,
  reviewTask,
  runKit,
  settle,
} from "./harnessReview.testkit.ts";
import { HoustonScheduledTaskRunner } from "./ScheduledTaskRunner.ts";

const service = HoustonHarnessService.HoustonHarnessService;
const store = HoustonHarnessStore.HoustonHarnessStore;

const kindOf = (error: unknown) => (error as { readonly kind?: string }).kind;
const messageOf = (error: unknown) => (error as { readonly message?: string }).message ?? "";

/** Moves the clock just past the task's next run and lets the scheduler poll fire it. */
const fireDue = (task: ScheduledTask) =>
  Effect.gen(function* () {
    assert.isNotNull(task.nextRunAt, `task ${task.id} has a next run`);
    yield* TestClock.setTime(Date.parse(task.nextRunAt!) + 1_000);
    yield* TestClock.adjust("6 seconds");
    yield* awaitRun(task);
  });

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

describe("what may start a review", () => {
  it.effect("a webhook never starts a review and only a running review publishes", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("webhook-publish");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const claim = yield* HoustonScheduledTaskRunner;
          const { projectId } = yield* createProject("webhook");
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          const task = (yield* reviewTask(projectId))!;
          assert.isTrue(yield* claim.claims(task));
          const refused = yield* Effect.flip(claim.run(task, "webhook"));
          assert.equal(kindOf(refused), "unsupported");
          assert.include(messageOf(refused), "webhook");
          assert.include(messageOf(refused), "weekly, daily or manual");
          assert.lengthOf(yield* reviews.listReviews(projectId, 50), 0);
          assert.lengthOf(kit.harness.log.started, 0);

          // publish settles only a running review: a failed or preparing one keeps its state.
          const findings = [
            {
              key: "late",
              title: "Late",
              category: "tools",
              confidence: "high",
              sessions: ["t-1"],
              count: 1,
              quotes: ["q"],
              recommendationKind: "claude-md",
              target: "CLAUDE.md",
              recommendation: "Say it",
              applyPrompt: "Add a line",
            },
          ];
          const publishInput = {
            endedAt: "2026-10-30T09:10:00.000Z",
            windowSince: null,
            windowUntil: null,
            threads: null,
            prompts: null,
            costUsd: null,
            summary: "1 findings",
            findings,
            verifications: [],
          };
          const preparing = yield* reviews.openReview({
            projectId,
            trigger: "manual",
            scheduledTaskId: null,
            providerInstanceId: "claudeAgent",
            startedAt: "2026-10-30T09:00:00.000Z",
          });
          yield* reviews.publish(preparing.id, publishInput);
          assert.equal((yield* reviews.getReview(preparing.id))!.status, "preparing");
          yield* reviews.fail(preparing.id, { endedAt: "2026-10-30T09:05:00.000Z", error: "x" });
          yield* reviews.publish(preparing.id, publishInput);
          const failed = (yield* reviews.getReview(preparing.id))!;
          assert.equal(failed.status, "failed");
          assert.equal(failed.error, "x");
          assert.lengthOf(yield* reviews.findingRows(projectId), 0);
        }),
      );
    }),
  );
});

describe("setting up a review", () => {
  it.effect("setup creates the review as a scheduled task for each schedule", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("setup-schedules");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const expected = {
            weekly: {
              schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0] },
              enabled: true,
            },
            daily: { schedule: { type: "fixed_time", timeOfDay: "09:00" }, enabled: true },
            manual: {
              schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0] },
              enabled: false,
            },
          } as const;
          for (const schedule of ["weekly", "daily", "manual"] as const) {
            const { projectId } = yield* createProject(`setup-${schedule}`);
            const selection = model("claudeAgent", "claude-sonnet-4-6");
            const snapshot = yield* harness.setup({
              projectId,
              modelSelection: selection,
              schedule,
            });
            const task = yield* reviewTask(projectId);
            assert.isDefined(task, schedule);
            assert.equal(task!.title, `Harness review · setup-${schedule}`);
            assert.deepEqual(task!.schedule, expected[schedule].schedule as never, schedule);
            assert.equal(task!.enabled, expected[schedule].enabled, schedule);
            assert.deepEqual(task!.workspaceStrategy, { type: "root" });
            assert.deepEqual(task!.modelSelection, selection);
            assert.equal(task!.projectId, projectId);
            assert.isNull(task!.threadId);
            assert.equal(snapshot.schedule?.scheduledTaskId, task!.id);
            assert.equal(snapshot.schedule?.enabled, expected[schedule].enabled);
            if (schedule === "daily") assert.isFalse("weekdays" in task!.schedule);
            if (schedule === "manual") assert.isNull(task!.nextRunAt);
          }
          const { tasks } = yield* scheduled.list();
          assert.lengthOf(tasks, 3);
          yield* settle;
          const rows = yield* (yield* store).listReviews(
            ProjectId.make("project-setup-manual"),
            50,
          );
          assert.lengthOf(rows, 0);
          assert.lengthOf(kit.harness.log.started, 0);
        }),
      );
    }),
  );

  it.effect("a project has one review schedule until its task is deleted", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("setup-once");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const { projectId } = yield* createProject("once");
          const input = {
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "weekly",
          } as const;
          yield* harness.setup(input);
          const first = yield* reviewTask(projectId);
          const error = yield* Effect.flip(harness.setup(input));
          assert.equal(kindOf(error), "conflict");
          assert.include(messageOf(error), first!.id);
          assert.include(messageOf(error), "change it in Scheduled tasks");
          assert.lengthOf((yield* scheduled.list()).tasks, 1);

          yield* scheduled.delete({ id: first!.id });
          const again = yield* harness.setup({ ...input, schedule: "daily" });
          const second = yield* reviewTask(projectId);
          assert.isDefined(second);
          assert.notEqual(second!.id, first!.id);
          assert.equal(again.schedule?.scheduledTaskId, second!.id);
          assert.equal((yield* (yield* store).settings(projectId))?.scheduledTaskId, second!.id);
          assert.lengthOf((yield* scheduled.list()).tasks, 1);
        }),
      );
    }),
  );

  it.effect("only a provider that runs read-only can review", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("read-only-providers");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          for (const instance of ["claudeAgent", "codex", "opencode", "opencode2"]) {
            const { projectId } = yield* createProject(`accept-${instance}`);
            yield* harness.setup({
              projectId,
              modelSelection: model(instance),
              schedule: "manual",
            });
            const started = yield* harness.runNow({ projectId });
            assert.isAbove(started.reviewId, 0, instance);
            yield* settle;
            assert.lengthOf(yield* reviews.listReviews(projectId, 50), 1, instance);
          }
          const startedBefore = kit.harness.log.started.length;

          const { projectId } = yield* createProject("refuse-antigravity");
          const refusedSetup = yield* Effect.flip(
            harness.setup({ projectId, modelSelection: model("antigravity"), schedule: "weekly" }),
          );
          assert.equal(kindOf(refusedSetup), "unsupported");
          assert.include(messageOf(refusedSetup), "antigravity");
          assert.include(messageOf(refusedSetup), "read_only_run");
          assert.isUndefined(yield* reviewTask(projectId));

          // Set up on Claude, then switched to Antigravity in Scheduled tasks.
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "weekly",
          });
          const task = yield* reviewTask(projectId);
          yield* upsertFrom(task!, { modelSelection: model("antigravity") });
          const refusedRun = yield* Effect.flip(harness.runNow({ projectId }));
          assert.equal(kindOf(refusedRun), "unsupported");
          assert.include(messageOf(refusedRun), "antigravity");
          assert.include(messageOf(refusedRun), "read_only_run");

          yield* fireDue((yield* reviewTask(projectId))!);
          const fired = yield* reviewTask(projectId);
          assert.equal(fired!.lastRunStatus, "failed");
          assert.include(fired!.lastRunError ?? "", "antigravity");
          assert.include(fired!.lastRunError ?? "", "read_only_run");
          assert.lengthOf(yield* reviews.listReviews(projectId, 50), 0);
          assert.equal(kit.harness.log.started.length, startedBefore);
        }),
      );
    }),
  );

  it.effect("a mapped task runs the review and an unmapped task runs unchanged", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("mapped-and-unmapped");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const reviews = yield* store;
          const { projectId } = yield* createProject("mapped");
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "weekly",
          });
          const setUp = yield* reviewTask(projectId);
          yield* upsertFrom(setUp!, { modelSelection: model("codex", "gpt-5.4") });
          const before = (yield* reviewTask(projectId))!;
          assert.equal(before.runCount, 0);

          yield* fireDue(before);
          const after = (yield* reviewTask(projectId))!;
          const fired = yield* reviews.listReviews(projectId, 50);
          assert.lengthOf(fired, 1);
          assert.equal(fired[0]!.trigger, "scheduled");
          assert.equal(fired[0]!.scheduledTaskId, before.id);
          const reviewTurns = kit.harness.log.started.filter(
            (turn) => turn.input.threadId === fired[0]!.threadId,
          );
          assert.isAbove(
            reviewTurns.length,
            0,
            JSON.stringify({
              review: fired[0],
              started: kit.harness.log.started.map((turn) => [turn.driver, turn.input.threadId]),
            }),
          );
          assert.equal(reviewTurns[0]!.driver, "codex");
          assert.equal(after.lastRunStatus, "succeeded");
          assert.equal(after.runCount, 1);
          assert.isNotNull(after.lastRunAt);
          assert.isAbove(Date.parse(after.nextRunAt!), Date.parse(before.nextRunAt!));
          assert.lengthOf(kit.launches, 0);

          yield* settle;
          const now = yield* harness.runNow({ projectId });
          const afterRunNow = (yield* reviewTask(projectId))!;
          assert.equal(afterRunNow.runCount, 2);
          assert.equal(afterRunNow.lastRunStatus, "succeeded");
          const both = yield* reviews.listReviews(projectId, 50);
          assert.lengthOf(both, 2);
          assert.equal(both[0]!.id, now.reviewId);
          assert.equal(both[0]!.trigger, "manual");
          assert.equal(both[0]!.threadId, now.threadId);

          const plain = yield* scheduled.upsert({
            title: "Dependency check",
            prompt: "Check the dependencies",
            enabled: false,
            schedule: { type: "fixed_time", timeOfDay: "10:00" },
            projectId,
            workspaceStrategy: { type: "root" },
            modelSelection: model("claudeAgent"),
            runtimeMode: "full-access",
            interactionMode: "default",
          });
          const ran = yield* scheduled.runNow({ id: plain.task.id });
          assert.lengthOf(kit.launches, 1);
          assert.equal(kit.launches[0]!.prompt, "Check the dependencies");
          assert.equal(ran.threadId, kit.launches[0]!.threadId);
          assert.lengthOf(yield* reviews.listReviews(projectId, 50), 2);
        }),
      );
    }),
  );

  it.effect("run now needs a set-up review", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("run-now-not-set-up");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
          const { projectId } = yield* createProject("never");
          const never = yield* Effect.flip(harness.runNow({ projectId }));
          assert.equal(kindOf(never), "not_found");
          assert.include(messageOf(never), "set up the harness review first");

          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          yield* scheduled.delete({ id: (yield* reviewTask(projectId))!.id });
          const deleted = yield* Effect.flip(harness.runNow({ projectId }));
          assert.equal(kindOf(deleted), "not_found");
          assert.include(messageOf(deleted), "set up the harness review first");
          assert.lengthOf(yield* (yield* store).listReviews(projectId, 50), 0);
        }),
      );
    }),
  );

  it.effect("a review task moved to another project does not run", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("moved-task");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const reviews = yield* store;
          const p = yield* createProject("moved-p");
          const q = yield* createProject("moved-q");
          yield* harness.setup({
            projectId: p.projectId,
            modelSelection: model("claudeAgent"),
            schedule: "weekly",
          });
          const task = (yield* reviewTask(p.projectId))!;
          yield* upsertFrom(task, { projectId: q.projectId });
          yield* fireDue((yield* reviewTask(p.projectId))!);
          const fired = (yield* reviewTask(p.projectId))!;
          assert.equal(fired.lastRunStatus, "failed");
          assert.include(fired.lastRunError ?? "", p.projectId);
          assert.include(fired.lastRunError ?? "", q.projectId);
          assert.include(
            fired.lastRunError ?? "",
            "set the review up again in the project it reviews",
          );
          assert.lengthOf(yield* reviews.listReviews(p.projectId, 50), 0);
          assert.lengthOf(yield* reviews.listReviews(q.projectId, 50), 0);
          assert.lengthOf(kit.harness.log.started, 0);
          assert.lengthOf(kit.launches, 0);
        }),
      );
    }),
  );
});

describe("startup", () => {
  it.effect("the server and the harness install the houston claim and one reactor", () =>
    Effect.gen(function* () {
      const source = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
      const count = (text: string, needle: string) => text.split(needle).length - 1;
      const server = source("../../server.ts");
      const runtime = source("../../orchestration-v2/runtimeLayer.ts");
      const kitSource = source("./harnessReview.testkit.ts");
      // One reactor: the server composes the harness review layer once, as the kit does.
      assert.equal(
        count(server, "layerHarnessReview"),
        2,
        "server.ts imports and provides it once",
      );
      assert.include(kitSource, "layerHarnessReview");
      // The claim: the scheduled task service gets the Houston runner in the server and the kit.
      // The server's hook composes this claim with Night shift's (nightShift/ScheduledTaskRunner.ts).
      assert.include(runtime, "layerHoustonScheduledTaskRunner");
      assert.include(kitSource, "layerHarnessScheduledTaskRunner");
      // Upstream's scheduled-task tests build the service without it and claim nothing.
      const upstreamTest = source("../../scheduledTasks/ScheduledTaskService.test.ts");
      assert.notInclude(upstreamTest, "HoustonScheduledTaskRunner");

      const kit = yield* makeKit("startup-claim");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* service;
          const { projectId } = yield* createProject("startup");
          yield* harness.setup({
            projectId,
            modelSelection: model("claudeAgent"),
            schedule: "manual",
          });
          yield* harness.runNow({ projectId });
          yield* settle;
          assert.lengthOf(kit.launches, 0, "the mapped task was claimed, not launched");
          assert.lengthOf(yield* (yield* store).listReviews(projectId, 50), 1);
        }),
      );
    }),
  );
});
