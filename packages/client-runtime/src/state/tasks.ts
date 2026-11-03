import { type EnvironmentId, WS_METHODS } from "@houston-app/contracts";
import {
  type HoustonTaskCounts,
  type HoustonTaskPriority,
  type HoustonTaskQueue,
  type HoustonTaskStreamEvent,
  type HoustonTaskSummary,
} from "@houston-app/contracts/houston/tasks";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** A task list with the server's counts; `loaded` is false until the first snapshot arrives. */
export interface TasksSnapshot {
  readonly tasks: ReadonlyArray<HoustonTaskSummary>;
  readonly counts: HoustonTaskCounts;
  readonly truncated: boolean;
  readonly loaded: boolean;
}

export const EMPTY_TASK_COUNTS: HoustonTaskCounts = {
  yourTurn: 0,
  ready: 0,
  backlog: 0,
  todo: 0,
  inProgress: 0,
  inReview: 0,
  done: 0,
  canceled: 0,
};

export const EMPTY_TASKS_SNAPSHOT: TasksSnapshot = {
  tasks: [],
  counts: EMPTY_TASK_COUNTS,
  truncated: false,
  loaded: false,
};

/** Mirrors the server's count of the summaries it answers with. */
export function taskCountsOf(tasks: ReadonlyArray<HoustonTaskSummary>): HoustonTaskCounts {
  const counts = { ...EMPTY_TASK_COUNTS };
  for (const task of tasks) {
    if (task.archivedAt !== null) continue;
    if (task.queue === "your_turn") counts.yourTurn += 1;
    if (task.status === "todo" && task.ready) counts.ready += 1;
    switch (task.status) {
      case "backlog":
        counts.backlog += 1;
        break;
      case "todo":
        counts.todo += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "in_review":
        counts.inReview += 1;
        break;
      case "done":
        counts.done += 1;
        break;
      case "canceled":
        counts.canceled += 1;
        break;
    }
  }
  return counts;
}

/** The fold every subscription applies: a snapshot replaces, a change upserts, a removal drops. */
export function applyTasksStreamEvent(
  current: TasksSnapshot,
  event: HoustonTaskStreamEvent,
): TasksSnapshot {
  if ("snapshot" in event) {
    return {
      tasks: event.snapshot.tasks,
      counts: event.snapshot.counts,
      truncated: event.snapshot.truncated,
      loaded: true,
    };
  }
  if ("changed" in event) {
    const changed = event.changed;
    const index = current.tasks.findIndex((task) => task.id === changed.id);
    const tasks =
      index === -1
        ? [...current.tasks, changed]
        : current.tasks.map((task, position) => (position === index ? changed : task));
    return { ...current, tasks, counts: taskCountsOf(tasks) };
  }
  const tasks = current.tasks.filter((task) => task.id !== event.removed.id);
  return tasks.length === current.tasks.length
    ? current
    : { ...current, tasks, counts: taskCountsOf(tasks) };
}

const priorityRank = (priority: HoustonTaskPriority): number => {
  switch (priority) {
    case "urgent":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    case "none":
      return 4;
  }
};

/** Queue order for Up next: priority, then oldest, then key number. */
export function compareTasksForQueue(
  left: Pick<HoustonTaskSummary, "priority" | "createdAt" | "number">,
  right: Pick<HoustonTaskSummary, "priority" | "createdAt" | "number">,
): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
    left.number - right.number
  );
}

export type TaskQueueSection = HoustonTaskQueue | "backlog";

/** Which section a summary sits in; done, canceled and archived sit in none of them. */
export function taskQueueSection(summary: HoustonTaskSummary): TaskQueueSection {
  if (summary.queue !== "none") return summary.queue;
  return "backlog";
}

export function taskIsFolded(summary: HoustonTaskSummary): boolean {
  return summary.archivedAt !== null || summary.status === "done" || summary.status === "canceled";
}

const TASK_WRITE_TAGS = [
  WS_METHODS.houstonTasksSave,
  WS_METHODS.houstonTasksComment,
  WS_METHODS.houstonTasksCheck,
  WS_METHODS.houstonTasksArchive,
  WS_METHODS.houstonTasksDomainSave,
  WS_METHODS.houstonTasksPlanAnswer,
  WS_METHODS.houstonTasksPlanApprove,
  WS_METHODS.houstonTasksHandback,
] as const;
type TaskWriteTag = (typeof TASK_WRITE_TAGS)[number];

export function createTaskEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tasks:detail",
    tag: WS_METHODS.houstonTasksGet,
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  });
  const initiatives = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tasks:initiatives",
    tag: WS_METHODS.houstonTasksInitiativesList,
    staleTimeMs: 10_000,
    idleTtlMs: 60_000,
  });
  const refreshDetail = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    id: string,
  ) => registry.refresh(detail({ environmentId, input: { id } }));

  /** A write refreshes the detail it touched; the list follows the subscription's changes. */
  const write = (label: string, tag: TaskWriteTag) =>
    createEnvironmentRpcCommand(runtime, {
      label,
      tag,
      scheduler,
      concurrency,
      onSuccess: (target, registry) => {
        const id = "id" in target.input ? target.input.id : undefined;
        return typeof id === "string"
          ? Effect.sync(() => refreshDetail(registry, target.environmentId, id))
          : Effect.void;
      },
    });

  return {
    /** The live list and counts for one scope. */
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:tasks:list",
      tag: WS_METHODS.houstonTasksSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_TASKS_SNAPSHOT, applyTasksStreamEvent)),
    }),
    detail,
    initiatives,
    settings: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:tasks:settings",
      tag: WS_METHODS.houstonTasksSettingsGet,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    save: write("environment-data:tasks:save", WS_METHODS.houstonTasksSave),
    comment: write("environment-data:tasks:comment", WS_METHODS.houstonTasksComment),
    check: write("environment-data:tasks:check", WS_METHODS.houstonTasksCheck),
    archive: write("environment-data:tasks:archive", WS_METHODS.houstonTasksArchive),
    saveDomain: write("environment-data:tasks:domain-save", WS_METHODS.houstonTasksDomainSave),
    saveInitiative: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:initiative-save",
      tag: WS_METHODS.houstonTasksInitiativesSave,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            initiatives({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId },
            }),
          ),
        ),
    }),
    archiveInitiative: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:initiative-archive",
      tag: WS_METHODS.houstonTasksInitiativesArchive,
      scheduler,
      concurrency,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:start",
      tag: WS_METHODS.houstonTasksStart,
      scheduler,
      concurrency,
      onSuccess: (target, registry) =>
        Effect.sync(() => {
          if (typeof target.input.id === "string") {
            refreshDetail(registry, target.environmentId, target.input.id);
          }
        }),
    }),
    runControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:run-control",
      tag: WS_METHODS.houstonTasksRunControl,
      scheduler,
      concurrency,
    }),
    planStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:plan-start",
      tag: WS_METHODS.houstonTasksPlanStart,
      scheduler,
      concurrency,
    }),
    planAnswer: write("environment-data:tasks:plan-answer", WS_METHODS.houstonTasksPlanAnswer),
    planApprove: write("environment-data:tasks:plan-approve", WS_METHODS.houstonTasksPlanApprove),
    reviewStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tasks:review-start",
      tag: WS_METHODS.houstonTasksReviewStart,
      scheduler,
      concurrency,
    }),
  };
}
