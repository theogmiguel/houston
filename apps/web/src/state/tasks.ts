import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@houston-app/contracts";
import type {
  HoustonTaskDetail,
  HoustonTaskInitiative,
  HoustonTaskScope,
  HoustonTaskSettings,
  HoustonTaskSummary,
} from "@houston-app/contracts/houston/tasks";
import {
  EMPTY_TASKS_SNAPSHOT,
  createTaskEnvironmentAtoms,
  type TasksSnapshot,
} from "@houston-app/client-runtime/state/tasks";
import * as Cause from "effect/Cause";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { executeAtomQuery } from "@houston-app/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const tasksEnvironment = createTaskEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SNAPSHOT_ATOM = Atom.make(AsyncResult.success(EMPTY_TASKS_SNAPSHOT)).pipe(
  Atom.withLabel("web-tasks:snapshot:empty"),
);
const EMPTY_INITIATIVES_ATOM = Atom.make(
  AsyncResult.initial(true) as AsyncResult.AsyncResult<
    ReadonlyArray<HoustonTaskInitiative>,
    unknown
  >,
).pipe(Atom.withLabel("web-tasks:initiatives:empty"));
const EMPTY_SETTINGS_ATOM = Atom.make(
  AsyncResult.initial(true) as AsyncResult.AsyncResult<HoustonTaskSettings, unknown>,
).pipe(Atom.withLabel("web-tasks:settings:empty"));

export const ALL_TASKS_SCOPE: HoustonTaskScope = "all";

export function useTasks(
  environmentId: EnvironmentId | null,
  scope: HoustonTaskScope = ALL_TASKS_SCOPE,
): TasksSnapshot {
  const atom =
    environmentId === null
      ? EMPTY_SNAPSHOT_ATOM
      : tasksEnvironment.list({ environmentId, input: { scope } });
  return AsyncResult.getOrElse(useAtomValue(atom), () => EMPTY_TASKS_SNAPSHOT);
}

export interface TasksViewState {
  readonly snapshot: TasksSnapshot;
  readonly error: string | null;
}

/** The list and the message a failed subscription leaves; the stream reconnects on its own. */
export function useTasksView(
  environmentId: EnvironmentId | null,
  scope: HoustonTaskScope = ALL_TASKS_SCOPE,
): TasksViewState {
  const atom =
    environmentId === null
      ? EMPTY_SNAPSHOT_ATOM
      : tasksEnvironment.list({ environmentId, input: { scope } });
  const result = useAtomValue(atom);
  if (AsyncResult.isFailure(result)) {
    return { snapshot: EMPTY_TASKS_SNAPSHOT, error: taskFailureMessage(result.cause) };
  }
  return {
    snapshot: AsyncResult.getOrElse(result, () => EMPTY_TASKS_SNAPSHOT),
    error: null,
  };
}

function taskFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The task list could not be read.";
}

/** The primary environment whose channel owns the task backlog. */
export function usePrimaryTaskEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

/** The global backlog, which the rail count and the terminal's task keys read. */
export function useAllTasks(): ReadonlyArray<HoustonTaskSummary> {
  return useTasks(usePrimaryTaskEnvironmentId(), ALL_TASKS_SCOPE).tasks;
}

export function useAllTasksSnapshot(): TasksSnapshot {
  return useTasks(usePrimaryTaskEnvironmentId(), ALL_TASKS_SCOPE);
}

/** The rail's Your-turn count; null until the backlog snapshot arrives. */
export function useTaskYourTurnCount(): number | null {
  const snapshot = useAllTasksSnapshot();
  return snapshot.loaded ? snapshot.counts.yourTurn : null;
}

/** Whether the loaded global backlog knows a task key; the terminal only links known keys. */
export function isKnownTaskKey(key: string): boolean {
  const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  const snapshot = AsyncResult.getOrElse(
    appAtomRegistry.get(
      tasksEnvironment.list({ environmentId, input: { scope: ALL_TASKS_SCOPE } }),
    ),
    () => EMPTY_TASKS_SNAPSHOT,
  );
  const upper = key.toUpperCase();
  return snapshot.tasks.some((task) => task.key === upper);
}

export function useTaskForThread(threadId: string | null): HoustonTaskSummary | null {
  const tasks = useAllTasks();
  if (threadId === null) return null;
  return tasks.find((task) => task.openRun?.threadId === threadId) ?? null;
}

export function useTaskDetail(
  environmentId: EnvironmentId | null,
  id: string | null,
): AsyncResult.AsyncResult<HoustonTaskDetail, unknown> | null {
  const atom =
    environmentId === null || id === null
      ? null
      : tasksEnvironment.detail({ environmentId, input: { id } });
  // The hook order is stable: the empty atom takes the same slot when there is no target.
  const value = useAtomValue(atom ?? EMPTY_DETAIL_ATOM);
  if (environmentId === null || id === null) return null;
  return value;
}

const EMPTY_DETAIL_ATOM = Atom.make<AsyncResult.AsyncResult<HoustonTaskDetail, unknown>>(
  AsyncResult.initial(true),
).pipe(Atom.withLabel("web-tasks:detail:empty"));

export function useTaskInitiativesResult(
  environmentId: EnvironmentId | null,
  projectId: string | null,
): AsyncResult.AsyncResult<ReadonlyArray<HoustonTaskInitiative>, unknown> {
  const atom =
    environmentId === null || projectId === null
      ? null
      : tasksEnvironment.initiatives({
          environmentId,
          input: { projectId: projectId as ProjectId },
        });
  return useAtomValue(atom ?? EMPTY_INITIATIVES_ATOM);
}

export function useTaskSettings(
  environmentId: EnvironmentId | null,
  projectId: string | null,
): HoustonTaskSettings | null {
  const atom =
    environmentId === null || projectId === null
      ? null
      : tasksEnvironment.settings({
          environmentId,
          input: { projectId: projectId as ProjectId },
        });
  const result = useAtomValue(atom ?? EMPTY_SETTINGS_ATOM);
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** A write path needs the workspace's start model before it can plan. */
export async function loadTaskSettings(
  environmentId: EnvironmentId,
  projectId: string,
): Promise<HoustonTaskSettings | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    tasksEnvironment.settings({ environmentId, input: { projectId: projectId as ProjectId } }),
    { reportFailure: false },
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

export function refreshTaskInitiatives(environmentId: EnvironmentId, projectId: string): void {
  appAtomRegistry.refresh(
    tasksEnvironment.initiatives({
      environmentId,
      input: { projectId: projectId as ProjectId },
    }),
  );
}

export function refreshTaskDetail(environmentId: EnvironmentId, id: string): void {
  appAtomRegistry.refresh(tasksEnvironment.detail({ environmentId, input: { id } }));
}
