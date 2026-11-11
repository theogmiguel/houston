import { WS_METHODS } from "@houston-app/contracts";
import type {
  HoustonGridRecord,
  HoustonGridStreamEvent,
} from "@houston-app/contracts/houston/grids";
import { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** An environment's grids as the server last reported them; `loaded` is false until the first snapshot. */
export interface GridsSnapshot {
  readonly grids: ReadonlyArray<HoustonGridRecord>;
  readonly loaded: boolean;
}

export const EMPTY_GRIDS_SNAPSHOT: GridsSnapshot = { grids: [], loaded: false };

/** The fold every subscription applies: a snapshot replaces, an upsert replaces one grid, a delete drops it. */
export function applyGridStreamEvent(
  current: GridsSnapshot,
  event: HoustonGridStreamEvent,
): GridsSnapshot {
  if ("snapshot" in event) return { grids: event.snapshot.grids, loaded: true };
  if ("upserted" in event) {
    const upserted = event.upserted;
    const index = current.grids.findIndex((grid) => grid.id === upserted.id);
    return {
      loaded: current.loaded,
      grids:
        index === -1
          ? [...current.grids, upserted]
          : current.grids.map((grid, position) => (position === index ? upserted : grid)),
    };
  }
  const gridId = event.deleted.gridId;
  const grids = current.grids.filter((grid) => grid.id !== gridId);
  return grids.length === current.grids.length ? current : { loaded: current.loaded, grids };
}

export function createGridEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    /** Every grid of the environment, live. */
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:grids:list",
      tag: WS_METHODS.houstonGridsSubscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_GRIDS_SNAPSHOT, applyGridStreamEvent)),
    }),
    put: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grids:put",
      tag: WS_METHODS.houstonGridsPut,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:grids:delete",
      tag: WS_METHODS.houstonGridsDelete,
      scheduler,
      concurrency,
    }),
  };
}
