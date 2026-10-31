// The harness review as the server and its tests compose it: the claim upstream's scheduled tasks
// ask before launching, and the service with its one reactor.
import {
  HoustonHarnessError,
  type HoustonHarnessError as HoustonHarnessErrorType,
} from "@t3tools/contracts/houston/harnessReview";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as HarnessReviewReactor from "./Reactor.ts";
import * as HoustonHarnessRunner from "./Runner.ts";
import { HoustonScheduledTaskRunner } from "./ScheduledTaskRunner.ts";
import * as HoustonHarnessService from "./Service.ts";
import { HoustonHarnessStore } from "./Store.ts";

const makeClaim = Effect.gen(function* () {
  const store = yield* HoustonHarnessStore;
  const runner = yield* HoustonHarnessRunner.HoustonHarnessRunner;
  const refusals = yield* Ref.make<ReadonlyMap<string, HoustonHarnessErrorType>>(new Map());
  const remember = (taskId: string, refusal: HoustonHarnessErrorType | undefined) =>
    Ref.update(refusals, (current) => {
      const next = new Map(current);
      if (refusal === undefined) next.delete(taskId);
      else next.set(taskId, refusal);
      return next;
    });

  return HoustonScheduledTaskRunner.of({
    claims: Effect.fn("HoustonScheduledTaskRunner.claims")(function* (task) {
      return (yield* store.projectOfTask(task.id)) !== undefined;
    }),
    run: Effect.fn("HoustonScheduledTaskRunner.run")(
      function* (task, trigger) {
        const projectId = yield* store.projectOfTask(task.id);
        if (projectId === undefined) {
          return yield* new HoustonHarnessError({
            kind: "not_found",
            operation: "scheduledRun",
            message: `scheduled task ${task.id} reviews no project; set up the harness review first`,
          });
        }
        // A webhook would let any caller that holds its URL start reviews of the project.
        if (trigger === "webhook") {
          return yield* new HoustonHarnessError({
            kind: "unsupported",
            operation: "scheduledRun",
            message: `a harness review never runs from a webhook; give scheduled task ${task.id} a weekly, daily or manual schedule`,
          });
        }
        if (projectId !== task.projectId) {
          return yield* new HoustonHarnessError({
            kind: "invalid",
            operation: "scheduledRun",
            message: `this harness review task reviews project ${projectId} but was moved to project ${task.projectId}; set the review up again in the project it reviews`,
          });
        }
        const started = yield* runner.start({
          projectId,
          modelSelection: task.modelSelection,
          trigger,
          scheduledTaskId: task.id,
        });
        return started.threadId;
      },
      (effect, task) =>
        effect.pipe(
          Effect.tap(() => remember(task.id, undefined)),
          Effect.tapError((refusal) => remember(task.id, refusal)),
        ),
    ),
    lastRefusal: Effect.fn("HoustonScheduledTaskRunner.lastRefusal")(function* (taskId) {
      return (yield* Ref.get(refusals)).get(taskId);
    }),
  });
});

/** The Houston claim for upstream's scheduled tasks: a mapped task runs the project's review. */
export const layerHarnessScheduledTaskRunner = Layer.effect(
  HoustonScheduledTaskRunner,
  makeClaim,
).pipe(Layer.provide(HoustonHarnessRunner.layer));

/** The service and its reactor; the reactor settles open reviews when the layer starts. */
export const layerHarnessReview = Layer.mergeAll(
  HoustonHarnessService.layer,
  HarnessReviewReactor.layer,
);
