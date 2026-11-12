import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import {
  createLayoutWorkspaceEnvironmentAtoms,
  EMPTY_LAYOUT_WORKSPACES_SNAPSHOT,
  type LayoutWorkspacesSnapshot,
} from "@houston-app/client-runtime/state/layoutWorkspaces";
import type { EnvironmentId } from "@houston-app/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useLayoutStore } from "./layoutStore";
import { type LayoutSyncDeps, startLayoutSync } from "./layoutSync";

export const layoutWorkspacesEnvironment =
  createLayoutWorkspaceEnvironmentAtoms(connectionAtomRuntime);

/** The failure a command carries; a server refusal keeps its `kind` so the sync can tell them apart. */
function failureOf(cause: unknown): Error {
  const error = squashAtomCommandFailure({ cause } as never);
  return error instanceof Error ? error : new Error(String(error));
}

function depsFor(environmentId: EnvironmentId): LayoutSyncDeps {
  return {
    store: useLayoutStore,
    watchServer: (listener) => {
      const atom = layoutWorkspacesEnvironment.list({ environmentId, input: {} });
      const emit = (result: AsyncResult.AsyncResult<LayoutWorkspacesSnapshot, unknown>) =>
        listener(AsyncResult.getOrElse(result, () => EMPTY_LAYOUT_WORKSPACES_SNAPSHOT));
      return appAtomRegistry.subscribe(atom, emit, { immediate: true });
    },
    put: async (input) => {
      const result = await layoutWorkspacesEnvironment.put.run(appAtomRegistry, {
        environmentId,
        input,
      });
      if (result._tag === "Success") return result.value;
      throw failureOf(result.cause);
    },
    reorder: async (workspaceIds) => {
      const result = await layoutWorkspacesEnvironment.reorder.run(appAtomRegistry, {
        environmentId,
        input: { workspaceIds },
      });
      if (result._tag === "Success") return result.value;
      throw failureOf(result.cause);
    },
    delete: async (workspaceId) => {
      const result = await layoutWorkspacesEnvironment.delete.run(appAtomRegistry, {
        environmentId,
        input: { workspaceId },
      });
      if (result._tag === "Success") return result.value;
      throw failureOf(result.cause);
    },
  };
}

/**
 * Starts the layout sync against the primary environment's server, which stores the layout of
 * every environment's threads. Restarts when the primary environment changes. Returns a stop function.
 */
export function startAppLayoutSync(): () => void {
  let stopCurrent: (() => void) | null = null;
  const follow = (environmentId: EnvironmentId | null) => {
    stopCurrent?.();
    stopCurrent = environmentId === null ? null : startLayoutSync(depsFor(environmentId));
  };
  follow(appAtomRegistry.get(primaryEnvironmentIdAtom));
  const stopWatching = subscribeAtomChanges(primaryEnvironmentIdAtom, follow);
  return () => {
    stopWatching();
    stopCurrent?.();
  };
}
