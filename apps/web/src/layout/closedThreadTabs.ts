import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { useEffect, useState } from "react";

import { useQuietThreadShells } from "../state/entities";
import { closeLayoutThread } from "./layoutActions";

type WatchedShell = Pick<EnvironmentThreadShell, "environmentId" | "id" | "settledOverride">;

/**
 * Closes a thread's chat tab when the thread turns closed, by any route (a merge included). Only
 * the change from open to closed counts: a thread first seen closed, such as one opened from the
 * Closed shelf, keeps its tab.
 */
export function createClosedThreadTabWatcher(): (shells: ReadonlyArray<WatchedShell>) => void {
  let closedByKey = new Map<string, boolean>();
  return (shells) => {
    const next = new Map<string, boolean>();
    for (const shell of shells) {
      const threadRef = scopeThreadRef(shell.environmentId, shell.id);
      const key = scopedThreadKey(threadRef);
      const closed = shell.settledOverride === "settled";
      next.set(key, closed);
      if (closed && closedByKey.get(key) === false)
        closeLayoutThread(threadRef, { chatOnly: true });
    }
    closedByKey = next;
  };
}

export function useCloseTabsOfClosedThreads(): void {
  const shells = useQuietThreadShells();
  const [watch] = useState(createClosedThreadTabWatcher);
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- Closes layout tabs, an external store, when a thread shell turns closed.
  useEffect(() => {
    watch(shells);
  }, [shells, watch]);
}
