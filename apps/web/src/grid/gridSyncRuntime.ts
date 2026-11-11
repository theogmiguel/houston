import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import {
  createGridEnvironmentAtoms,
  EMPTY_GRIDS_SNAPSHOT,
  type GridsSnapshot,
} from "@houston-app/client-runtime/state/grids";
import type { EnvironmentId } from "@houston-app/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { type GridSyncDeps, startGridSync } from "./gridSync";
import { useGridStore } from "./gridStore";

export const gridsEnvironment = createGridEnvironmentAtoms(connectionAtomRuntime);

/** Key of the environments whose cached grids were already offered to their server. */
export const GRID_IMPORTED_STORAGE_KEY = "houston:grids:imported:v1";

/** Far above the environments one person connects; bounds what a corrupt value can grow into. */
export const MAX_IMPORTED_ENVIRONMENTS = 64;

export function createImportedEnvironments(storage: Pick<Storage, "getItem" | "setItem">) {
  const read = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(GRID_IMPORTED_STORAGE_KEY) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((id): id is string => typeof id === "string")
        .slice(-MAX_IMPORTED_ENVIRONMENTS);
    } catch {
      return [];
    }
  };
  return {
    has: (environmentId: string) => read().includes(environmentId),
    add: (environmentId: string) => {
      const ids = read();
      if (ids.includes(environmentId)) return;
      try {
        storage.setItem(
          GRID_IMPORTED_STORAGE_KEY,
          JSON.stringify([...ids, environmentId].slice(-MAX_IMPORTED_ENVIRONMENTS)),
        );
      } catch {
        // Without storage the import may run again; the server refuses a duplicate grid id.
      }
    },
  };
}

function failureText(cause: unknown): Error {
  const error = squashAtomCommandFailure({ cause } as never);
  return error instanceof Error ? error : new Error(String(error));
}

/** Starts the grid sync against the app's connections. Returns a stop function. */
export function startAppGridSync(): () => void {
  const deps: GridSyncDeps = {
    store: useGridStore,
    watchConnectedEnvironments: (listener) => subscribeConnected(listener),
    watchServerGrids: (environmentId, listener) => {
      const atom = gridsEnvironment.list({
        environmentId: environmentId as EnvironmentId,
        input: {},
      });
      const emit = (result: AsyncResult.AsyncResult<GridsSnapshot, unknown>) =>
        listener(AsyncResult.getOrElse(result, () => EMPTY_GRIDS_SNAPSHOT));
      return appAtomRegistry.subscribe(atom, emit, { immediate: true });
    },
    put: async (environmentId, input) => {
      const result = await gridsEnvironment.put.run(appAtomRegistry, {
        environmentId: environmentId as EnvironmentId,
        input,
      });
      if (result._tag === "Success") return result.value;
      throw failureText(result.cause);
    },
    delete: async (environmentId, gridId) => {
      const result = await gridsEnvironment.delete.run(appAtomRegistry, {
        environmentId: environmentId as EnvironmentId,
        input: { gridId },
      });
      if (result._tag === "Success") return result.value;
      throw failureText(result.cause);
    },
    importedEnvironments: createImportedEnvironments(window.localStorage),
  };
  return startGridSync(deps);
}

function subscribeConnected(listener: (ids: ReadonlyArray<string>) => void): () => void {
  const atom = environmentSummaries.connectedEnvironmentIdsAtom;
  listener(appAtomRegistry.get(atom));
  return subscribeAtomChanges(atom, listener);
}
