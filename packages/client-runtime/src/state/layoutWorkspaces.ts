import { WS_METHODS } from "@houston-app/contracts";
import type {
  HoustonLayoutThreadMembership,
  HoustonLayoutWorkspaceRecord,
  HoustonLayoutWorkspaceStreamEvent,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** An environment's layout workspaces as the server last reported them; `loaded` is false until the first snapshot. */
export interface LayoutWorkspacesSnapshot {
  readonly workspaces: ReadonlyArray<HoustonLayoutWorkspaceRecord>;
  /** The workspace of each chat thread; an entry may name a thread the window has not loaded yet. */
  readonly memberships: ReadonlyArray<HoustonLayoutThreadMembership>;
  readonly loaded: boolean;
}

export const EMPTY_LAYOUT_WORKSPACES_SNAPSHOT: LayoutWorkspacesSnapshot = {
  workspaces: [],
  memberships: [],
  loaded: false,
};

/** The fold every subscription applies: a snapshot replaces, an upsert replaces one workspace, a delete drops it. */
export function applyLayoutWorkspaceStreamEvent(
  current: LayoutWorkspacesSnapshot,
  event: HoustonLayoutWorkspaceStreamEvent,
): LayoutWorkspacesSnapshot {
  if ("snapshot" in event) {
    return {
      workspaces: event.snapshot.workspaces,
      memberships: event.snapshot.memberships,
      loaded: true,
    };
  }
  if ("membership" in event) {
    const incoming = event.membership;
    const same = (row: HoustonLayoutThreadMembership) =>
      row.environmentId === incoming.environmentId && row.threadId === incoming.threadId;
    const index = current.memberships.findIndex(same);
    return {
      ...current,
      memberships:
        index === -1
          ? [...current.memberships, incoming]
          : current.memberships.map((row, position) => (position === index ? incoming : row)),
    };
  }
  if ("membershipRemoved" in event) {
    const gone = event.membershipRemoved;
    const memberships = current.memberships.filter(
      (row) => !(row.environmentId === gone.environmentId && row.threadId === gone.threadId),
    );
    return memberships.length === current.memberships.length
      ? current
      : { ...current, memberships };
  }
  if ("upserted" in event) {
    const upserted = event.upserted;
    const index = current.workspaces.findIndex((workspace) => workspace.id === upserted.id);
    return {
      ...current,
      workspaces:
        index === -1
          ? [...current.workspaces, upserted]
          : current.workspaces.map((workspace, position) =>
              position === index ? upserted : workspace,
            ),
    };
  }
  const workspaceId = event.deleted.workspaceId;
  const workspaces = current.workspaces.filter((workspace) => workspace.id !== workspaceId);
  return workspaces.length === current.workspaces.length ? current : { ...current, workspaces };
}

export function createLayoutWorkspaceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    /** Every layout workspace of the environment, live. */
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:layout-workspaces:list",
      tag: WS_METHODS.houstonLayoutWorkspacesSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(() => EMPTY_LAYOUT_WORKSPACES_SNAPSHOT, applyLayoutWorkspaceStreamEvent),
        ),
    }),
    put: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:put",
      tag: WS_METHODS.houstonLayoutWorkspacesPut,
      scheduler,
      concurrency,
    }),
    assignThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:assign-thread",
      tag: WS_METHODS.houstonLayoutWorkspacesAssignThread,
      scheduler,
      concurrency,
    }),
    moveThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:move-thread",
      tag: WS_METHODS.houstonLayoutWorkspacesMoveThread,
      scheduler,
      concurrency,
    }),
    setFocus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:set-focus",
      tag: WS_METHODS.houstonLayoutWorkspacesSetFocus,
      scheduler,
      concurrency,
    }),
    reorder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:reorder",
      tag: WS_METHODS.houstonLayoutWorkspacesReorder,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:layout-workspaces:delete",
      tag: WS_METHODS.houstonLayoutWorkspacesDelete,
      scheduler,
      concurrency,
    }),
  };
}
