// Night shift's claim on upstream's scheduled tasks, composed with the harness review's into the one
// hook `ScheduledTaskService` asks, and the catch-up of a night the server missed.
import type { ScheduledTask, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { HoustonNightShiftError } from "@t3tools/contracts/houston/nightShift";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { makeClaim as makeHarnessClaim } from "../harnessReview/layer.ts";
import * as HoustonHarnessRunner from "../harnessReview/Runner.ts";
import {
  HoustonScheduledTaskRunner,
  type ScheduledTaskTrigger,
} from "../harnessReview/ScheduledTaskRunner.ts";
import { NightShiftMachine } from "./Host.ts";
import { HoustonNightShiftRunner } from "./Runner.ts";
import { HoustonNightShiftStore } from "./Store.ts";
import { catchUpStart } from "./window.ts";

export const FIXED_TIME_ONLY = "Night shift runs on a fixed time; set it up again";

export class HoustonNightShiftClaim extends Context.Service<
  HoustonNightShiftClaim,
  {
    readonly claims: (task: ScheduledTask) => Effect.Effect<boolean>;
    readonly run: (
      task: ScheduledTask,
      trigger: ScheduledTaskTrigger,
    ) => Effect.Effect<ThreadId, HoustonNightShiftError>;
    /** Holds a Run now's duration until the claim of that task reads it. */
    readonly holdDuration: (taskId: ScheduledTaskId, minutes: number) => Effect.Effect<void>;
    /** The refusal of the task's last claimed run, if it was refused. */
    readonly lastRefusal: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<HoustonNightShiftError | undefined>;
  }
>()("houston/houston/nightShift/ScheduledTaskRunner/HoustonNightShiftClaim") {}

const without = <K, V>(map: ReadonlyMap<K, V>, key: K) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};

export const layerClaim = Layer.effect(
  HoustonNightShiftClaim,
  Effect.gen(function* () {
    const store = yield* HoustonNightShiftStore;
    const runner = yield* HoustonNightShiftRunner;
    const durations = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const refusals = yield* Ref.make<ReadonlyMap<string, HoustonNightShiftError>>(new Map());
    const remember = (taskId: string, refusal: HoustonNightShiftError | undefined) =>
      Ref.update(refusals, (current) =>
        refusal === undefined ? without(current, taskId) : new Map(current).set(taskId, refusal),
      );

    const run = Effect.fn("HoustonNightShiftClaim.run")(function* (
      task: ScheduledTask,
      trigger: ScheduledTaskTrigger,
    ) {
      const operation = trigger === "scheduled" ? "scheduledRun" : "runNow";
      const durationMinutes = yield* Ref.modify(durations, (current) => [
        current.get(task.id),
        without(current, task.id),
      ]);
      const projectId = yield* store.projectOfTask(task.id);
      if (projectId === undefined) {
        return yield* new HoustonNightShiftError({
          kind: "not_found",
          operation,
          message: `scheduled task ${task.id} runs no Night shift; set it up first`,
        });
      }
      if (projectId !== task.projectId) {
        return yield* new HoustonNightShiftError({
          kind: "invalid",
          operation,
          message: `this Night shift task belongs to project ${projectId} but was moved to project ${task.projectId}; set it up again in its project`,
        });
      }
      if (task.schedule.type !== "fixed_time" || trigger === "webhook") {
        return yield* new HoustonNightShiftError({
          kind: "invalid",
          operation,
          message: FIXED_TIME_ONLY,
        });
      }
      const started = yield* runner.start({
        projectId,
        trigger: trigger === "scheduled" ? "scheduled" : "manual",
        scheduledTaskId: task.id,
        durationMinutes,
        operation,
      });
      return started.threadId;
    });

    return HoustonNightShiftClaim.of({
      claims: Effect.fn("HoustonNightShiftClaim.claims")((task) =>
        store.projectOfTask(task.id).pipe(Effect.map((id) => id !== undefined)),
      ),
      run: Effect.fn("HoustonNightShiftClaim.run")((task, trigger) =>
        run(task, trigger).pipe(
          Effect.tap(() => remember(task.id, undefined)),
          Effect.tapError((refusal) => remember(task.id, refusal)),
        ),
      ),
      holdDuration: Effect.fn("HoustonNightShiftClaim.holdDuration")((taskId, minutes) =>
        Ref.update(durations, (current) => new Map(current).set(taskId, minutes)),
      ),
      lastRefusal: Effect.fn("HoustonNightShiftClaim.lastRefusal")((taskId) =>
        Ref.get(refusals).pipe(Effect.map((current) => current.get(taskId))),
      ),
    });
  }),
);

/** The one hook: a task Night shift owns runs Night shift; any other goes to the harness review. */
export const layerHoustonScheduledTaskRunner = Layer.effect(
  HoustonScheduledTaskRunner,
  Effect.gen(function* () {
    const harness = yield* makeHarnessClaim;
    const night = yield* HoustonNightShiftClaim;
    return HoustonScheduledTaskRunner.of({
      claims: Effect.fn("HoustonScheduledTaskRunner.claims")(function* (task) {
        return (yield* night.claims(task)) || (yield* harness.claims(task));
      }),
      run: Effect.fn("HoustonScheduledTaskRunner.run")(function* (task, trigger) {
        return (yield* night.claims(task))
          ? yield* night.run(task, trigger)
          : yield* harness.run(task, trigger);
      }),
      lastRefusal: harness.lastRefusal,
    });
  }),
).pipe(Layer.provide(HoustonHarnessRunner.layer));

/** At server start: one catch-up run per project whose selected night started while it was down. */
export const catchUp = Effect.gen(function* () {
  const store = yield* HoustonNightShiftStore;
  const runner = yield* HoustonNightShiftRunner;
  const scheduled = yield* ScheduledTaskService.ScheduledTaskService;
  const machine = yield* NightShiftMachine;
  const nowMs = yield* Clock.currentTimeMillis;
  const timeZone = yield* machine.timeZone;
  const { tasks } = yield* scheduled.list().pipe(Effect.orDie);
  for (const { projectId, stored } of yield* store.allSettings) {
    const task = tasks.find((candidate) => candidate.id === stored.scheduledTaskId);
    if (task === undefined || !task.enabled || !stored.settings.enabled) continue;
    if (task.schedule.type !== "fixed_time") continue;
    const startMs = catchUpStart({
      nowMs,
      timeOfDay: task.schedule.timeOfDay,
      weekdays: task.schedule.weekdays ?? [],
      wrapUp: stored.settings.window.wrapUp,
      hardStop: stored.settings.window.hardStop,
      timeZone,
      runStarts: (yield* store.runStarts(projectId)).map((at) => Date.parse(at)),
    });
    if (startMs === null) continue;
    yield* runner
      .start({
        projectId,
        trigger: "catchUp",
        scheduledTaskId: task.id,
        windowStartMs: startMs,
        operation: "catchUp",
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Night shift could not catch up a missed night", {
            projectId,
            error: error.message,
          }),
        ),
      );
  }
});

/** Runs the catch-up once, when the layer starts. */
export const layerCatchUp = Layer.effectDiscard(
  catchUp.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Night shift catch-up failed", { cause })),
  ),
);
