// The hook upstream's scheduled tasks ask before launching a thread. Without it, every task
// launches as upstream does; Houston's layer (layer.ts) claims the tasks its features own.
import type { ScheduledTask, ThreadId } from "@t3tools/contracts";
import type { HoustonHarnessError } from "@t3tools/contracts/houston/harnessReview";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ScheduledTaskTrigger = "scheduled" | "manual" | "webhook";

export class HoustonScheduledTaskRunner extends Context.Service<
  HoustonScheduledTaskRunner,
  {
    readonly claims: (task: ScheduledTask) => Effect.Effect<boolean>;
    /** Runs a claimed task; the thread it returns is the run's thread. */
    readonly run: (
      task: ScheduledTask,
      trigger: ScheduledTaskTrigger,
    ) => Effect.Effect<ThreadId, HoustonHarnessError>;
    /** The refusal of the task's last claimed run, if it was refused. */
    readonly lastRefusal: (
      task: ScheduledTask["id"],
    ) => Effect.Effect<HoustonHarnessError | undefined>;
  }
>()("houston/houston/harnessReview/ScheduledTaskRunner/HoustonScheduledTaskRunner") {}
