import { WS_METHODS } from "@houston-app/contracts";
import type {
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
  readonly loaded: boolean;
}

export const EMPTY_LAYOUT_WORKSPACES_SNAPSHOT: LayoutWorkspacesSnapshot = {
  workspaces: [],
  loaded: false,
};

/** The fold every subscription applies: a snapshot replaces, an upsert replaces one workspace, a delete drops it. */
export function applyLayoutWorkspaceStreamEvent(
  current: LayoutWorkspacesSnapshot,
  event: HoustonLayoutWorkspaceStreamEvent,
): LayoutWorkspacesSnapshot {
  if ("snapshot" in event) return { workspaces: event.snapshot.workspaces, loaded: true };
  if ("upserted" in event) {
    const upserted = event.upserted;
    const index = current.workspaces.findIndex((workspace) => workspace.id === upserted.id);
    return {
      loaded: current.loaded,
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
  return workspaces.length === current.workspaces.length
    ? current
    : { loaded: current.loaded, workspaces };
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
