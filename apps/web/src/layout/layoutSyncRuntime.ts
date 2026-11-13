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
import { isPhoneViewport } from "../mobile/usePhone";
import { useLayoutStore } from "./layoutStore";
import { setEmptyWorkspaceRetention } from "./layoutModel";
import { setThreadMemberships, useThreadMembershipStore } from "./threadMembership";
import { type LayoutSyncDeps, type LayoutSyncHandle, startLayoutSync } from "./layoutSync";

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
      const emit = (result: AsyncResult.AsyncResult<LayoutWorkspacesSnapshot, unknown>) => {
        const snapshot = AsyncResult.getOrElse(result, () => EMPTY_LAYOUT_WORKSPACES_SNAPSHOT);
        if (snapshot.loaded) setThreadMemberships(snapshot.memberships, true);
        listener(snapshot);
      };
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

let activeSync: LayoutSyncHandle | null = null;

setEmptyWorkspaceRetention((workspaceId) =>
  useThreadMembershipStore.getState().occupied.has(workspaceId),
);

/** Sends any pending layout change now; resolves at once when no sync is running. */
export async function flushLayoutSync(): Promise<void> {
  await activeSync?.flush();
}

/** The primary environment, whose server stores the layout and every thread's workspace. */
export function layoutEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(primaryEnvironmentIdAtom);
}

/** Reports the focused workspace so the server can use it as the default for new threads. */
export function reportFocus(environmentId: EnvironmentId): () => void {
  let reported: string | null = null;
  const send = (workspaceId: string) => {
    if (isPhoneViewport() || workspaceId === reported) return;
    reported = workspaceId;
    void layoutWorkspacesEnvironment.setFocus
      .run(appAtomRegistry, { environmentId, input: { workspaceId } })
      .then((result) => {
        if (result._tag === "Failure") {
          reported = null;
          console.warn(
            `The server did not take workspace '${workspaceId}' as the focused one: ${failureOf(result.cause).message}`,
          );
        }
      });
  };
  return useLayoutStore.subscribe((state, previous) => {
    if (!state.layoutLoaded) return;
    if (
      state.layout.focusedWorkspaceId === previous.layout.focusedWorkspaceId &&
      previous.layoutLoaded
    ) {
      return;
    }
    send(state.layout.focusedWorkspaceId);
  });
}

/**
 * Starts the layout sync against the primary environment's server, which stores the layout of
 * every environment's threads. Restarts when the primary environment changes. Returns a stop function.
 */
export function startAppLayoutSync(): () => void {
  let stopCurrent: (() => void) | null = null;
  const follow = (environmentId: EnvironmentId | null) => {
    stopCurrent?.();
    if (environmentId === null) {
      stopCurrent = null;
      activeSync = null;
      return;
    }
    const sync = startLayoutSync(depsFor(environmentId));
    const stopFocus = reportFocus(environmentId);
    activeSync = sync;
    stopCurrent = () => {
      stopFocus();
      sync();
      if (activeSync === sync) activeSync = null;
    };
  };
  follow(appAtomRegistry.get(primaryEnvironmentIdAtom));
  const stopWatching = subscribeAtomChanges(primaryEnvironmentIdAtom, follow);
  return () => {
    stopWatching();
    stopCurrent?.();
  };
}
