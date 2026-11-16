import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@houston-app/client-runtime/state/runtime";
import { type EnvironmentId, type ProjectId, WS_METHODS } from "@houston-app/contracts";
import type { HoustonMergeQueueSnapshot } from "@houston-app/contracts/houston/mergeQueue";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const scheduler = createAtomCommandScheduler();
const serialPerProject = {
  mode: "serial",
  key: ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly projectId?: string };
  }) => `${environmentId}:${input.projectId ?? "*"}`,
} as const;

/**
 * The merge queue's reads are streams because the server owns the line: a push, a
 * parked entry or a pause changes what every reader must see at the same moment.
 */
export const mergeQueueEnvironment = {
  snapshot: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:merge-queue:snapshot",
    tag: WS_METHODS.houstonMergeQueueSubscribe,
  }),
  enqueue: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:enqueue",
    tag: WS_METHODS.houstonMergeQueueEnqueue,
    scheduler,
    concurrency: serialPerProject,
  }),
  dequeue: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:dequeue",
    tag: WS_METHODS.houstonMergeQueueDequeue,
    scheduler,
    concurrency: serialPerProject,
  }),
  mergeHead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:merge-head",
    tag: WS_METHODS.houstonMergeQueueMergeHead,
    scheduler,
    concurrency: serialPerProject,
  }),
  setSettings: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:settings-set",
    tag: WS_METHODS.houstonMergeQueueSettingsSet,
    scheduler,
    concurrency: serialPerProject,
  }),
  pause: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:pause",
    tag: WS_METHODS.houstonMergeQueuePause,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
    },
  }),
  retry: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:retry",
    tag: WS_METHODS.houstonMergeQueueRetry,
    scheduler,
    concurrency: serialPerProject,
  }),
  handToThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:hand-to-thread",
    tag: WS_METHODS.houstonMergeQueueHandToThread,
    scheduler,
    concurrency: serialPerProject,
  }),
  revert: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:revert",
    tag: WS_METHODS.houstonMergeQueueRevert,
    scheduler,
    concurrency: serialPerProject,
  }),
  acknowledge: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:merge-queue:acknowledge",
    tag: WS_METHODS.houstonMergeQueueAcknowledge,
    scheduler,
    concurrency: serialPerProject,
  }),
};

export interface MergeQueueSnapshotView {
  readonly snapshot: HoustonMergeQueueSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useMergeQueueSnapshot(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): MergeQueueSnapshotView {
  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : mergeQueueEnvironment.snapshot({ environmentId, input: { projectId } }),
  );
  return {
    snapshot: query.data,
    error: query.error,
    isPending: query.isPending,
    refresh: query.refresh,
  };
}

export interface MergeQueueProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface MergeQueueProjectSnapshot {
  readonly environmentId: EnvironmentId;
  readonly snapshot: HoustonMergeQueueSnapshot;
}

function mergeQueueTargetsKey(targets: ReadonlyArray<MergeQueueProjectTarget>): string {
  return JSON.stringify(
    [
      ...new Set(targets.map((target) => `${target.environmentId}\u0000${target.projectId}`)),
    ].toSorted(),
  );
}

/**
 * One subscription per project the list shows: the queue lives in each project's own
 * server state, and a page that spans projects still has to badge every row it draws.
 */
const mergeQueueSnapshotsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<MergeQueueProjectSnapshot> => {
    const targets = JSON.parse(key) as ReadonlyArray<string>;
    const snapshots: MergeQueueProjectSnapshot[] = [];
    for (const target of targets) {
      const separator = target.indexOf("\u0000");
      const environmentId = target.slice(0, separator) as EnvironmentId;
      const projectId = target.slice(separator + 1) as ProjectId;
      const result = get(mergeQueueEnvironment.snapshot({ environmentId, input: { projectId } }));
      if (result._tag === "Success") snapshots.push({ environmentId, snapshot: result.value });
    }
    return snapshots;
  }).pipe(Atom.withLabel(`web-merge-queue-snapshots:${key}`)),
);

export function useMergeQueueSnapshots(
  targets: ReadonlyArray<MergeQueueProjectTarget>,
): ReadonlyArray<MergeQueueProjectSnapshot> {
  return useAtomValue(mergeQueueSnapshotsAtom(mergeQueueTargetsKey(targets)));
}

/** The project's entry for one pull request, read from the live snapshot. */
export function useMergeQueueEntry(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  number: number | null,
) {
  const { snapshot, error, isPending } = useMergeQueueSnapshot(environmentId, projectId);
  const entry =
    snapshot === null || number === null
      ? null
      : (snapshot.entries.find((candidate) => candidate.number === number) ?? null);
  return { snapshot, entry, error, isPending };
}
