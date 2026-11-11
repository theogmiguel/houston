import type {
  HoustonGridDeleteResult,
  HoustonGridPutInput,
  HoustonGridPutResult,
  HoustonGridRecord,
} from "@houston-app/contracts/houston/grids";

import { serverContentKey, toServerRecord } from "./gridServerMerge";
import type { GridRecord, GridStoreState, useGridStore } from "./gridStore";

/**
 * How long a grid's changes settle before they are sent. A divider drag or a run of key presses
 * changes one grid many times a second; 300 ms is longer than the gap between those events and
 * short enough that an agent sees the finished layout within about a third of a second.
 */
export const GRID_PUSH_DEBOUNCE_MS = 300;

export interface GridSyncDeps {
  readonly store: Pick<typeof useGridStore, "getState" | "subscribe">;
  /** Calls `listener` with the connected environment ids now and on every change. */
  readonly watchConnectedEnvironments: (
    listener: (environmentIds: ReadonlyArray<string>) => void,
  ) => () => void;
  /** Calls `listener` with an environment's grids on every server event; the stream reconnects itself. */
  readonly watchServerGrids: (
    environmentId: string,
    listener: (snapshot: {
      readonly grids: ReadonlyArray<HoustonGridRecord>;
      readonly loaded: boolean;
    }) => void,
  ) => () => void;
  /** Rejects when the request fails or the server refuses it. */
  readonly put: (
    environmentId: string,
    input: HoustonGridPutInput,
  ) => Promise<HoustonGridPutResult>;
  readonly delete: (environmentId: string, gridId: string) => Promise<HoustonGridDeleteResult>;
  /** Environments whose cached grids were already offered to the server. */
  readonly importedEnvironments: {
    readonly has: (environmentId: string) => boolean;
    readonly add: (environmentId: string) => void;
  };
  readonly now?: () => string;
  readonly report?: (message: string) => void;
}

/**
 * Keeps the grid store and the servers' grids in step. The server owns a grid's name, tree, pin
 * and hidden flag: its changes flow into the store, and a local change to those fields is sent
 * back after it settles. A change is sent only when its content differs from what the server last
 * reported, so a change that came from the server is never echoed. Returns a stop function.
 */
export function startGridSync(deps: GridSyncDeps): () => void {
  const { store } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const report = deps.report ?? ((message: string) => console.warn(message));

  const synced = new Set<string>();
  const baseline = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const changedInFlight = new Set<string>();
  const pendingDeletes = new Set<string>();
  const unsent = new Set<string>();
  const watchers = new Map<string, () => void>();
  let applying = false;

  const state = (): GridStoreState => store.getState();
  const gridOf = (gridId: string): GridRecord | undefined =>
    state().grids.find((grid) => grid.id === gridId);

  const whileApplying = <T>(apply: () => T): T => {
    applying = true;
    try {
      return apply();
    } finally {
      applying = false;
    }
  };

  const cancelTimer = (gridId: string) => {
    const timer = timers.get(gridId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(gridId);
  };

  const schedule = (gridId: string) => {
    cancelTimer(gridId);
    timers.set(
      gridId,
      setTimeout(() => {
        timers.delete(gridId);
        void push(gridId);
      }, GRID_PUSH_DEBOUNCE_MS),
    );
  };

  const sendDelete = async (environmentId: string, gridId: string) => {
    pendingDeletes.add(gridId);
    try {
      await deps.delete(environmentId, gridId);
    } catch (error) {
      report(
        `Grid ${gridId} was deleted here but the server did not delete it: ${errorText(error)}`,
      );
    } finally {
      pendingDeletes.delete(gridId);
    }
  };

  async function push(gridId: string): Promise<void> {
    const grid = gridOf(gridId);
    if (grid === undefined || !synced.has(grid.environmentId)) return;
    if (inFlight.has(gridId)) {
      changedInFlight.add(gridId);
      return;
    }
    const key = serverContentKey(grid);
    const expected = state().serverRevisions[gridId];
    if (expected !== undefined && baseline.get(gridId) === key) return;
    const expectedRevision = expected ?? 0;
    inFlight.add(gridId);
    let result: HoustonGridPutResult;
    try {
      result = await deps.put(grid.environmentId, {
        grid: toServerRecord(grid, expectedRevision, now()),
        expectedRevision,
      });
    } catch (error) {
      report(
        `Grid ${gridId} (revision ${expectedRevision}) was not saved to the server: ${errorText(error)}`,
      );
      inFlight.delete(gridId);
      changedInFlight.delete(gridId);
      return;
    }
    inFlight.delete(gridId);
    const changedMeanwhile = changedInFlight.delete(gridId);
    if (result.status === "conflict") {
      cancelTimer(gridId);
      whileApplying(() => {
        if (result.current === null) {
          baseline.delete(gridId);
          state().deleteGrid(gridId);
        } else {
          baseline.set(gridId, serverContentKey(result.current));
          state().adoptServerGrid(result.current);
        }
      });
      return;
    }
    baseline.set(gridId, key);
    if (pendingDeletes.has(gridId) || gridOf(gridId) === undefined) {
      baseline.delete(gridId);
      await sendDelete(grid.environmentId, gridId);
      return;
    }
    whileApplying(() =>
      state().setServerRevision(gridId, result.grid.revision, result.grid.createdAt),
    );
    if (changedMeanwhile) schedule(gridId);
  }

  const onStoreChange = (next: GridStoreState, previous: GridStoreState) => {
    if (applying || next.grids === previous.grids) return;
    const before = new Map(previous.grids.map((grid) => [grid.id, grid] as const));
    for (const grid of next.grids) {
      const was = before.get(grid.id);
      before.delete(grid.id);
      if (was === grid) continue;
      if (!synced.has(grid.environmentId)) {
        if (was === undefined) unsent.add(grid.id);
        continue;
      }
      const known = baseline.get(grid.id);
      if (known !== undefined && known === serverContentKey(grid)) cancelTimer(grid.id);
      else schedule(grid.id);
    }
    for (const removed of before.values()) {
      cancelTimer(removed.id);
      unsent.delete(removed.id);
      if (!synced.has(removed.environmentId)) continue;
      if (inFlight.has(removed.id)) {
        pendingDeletes.add(removed.id);
      } else if (baseline.delete(removed.id)) {
        void sendDelete(removed.environmentId, removed.id);
      }
    }
  };
  const stopStore = store.subscribe(onStoreChange);

  const onServerGrids = (
    environmentId: string,
    snapshot: { readonly grids: ReadonlyArray<HoustonGridRecord>; readonly loaded: boolean },
  ) => {
    if (!snapshot.loaded) return;
    synced.add(environmentId);
    const records = snapshot.grids.filter((record) => !pendingDeletes.has(record.id));
    const skip = new Set<string>([...timers.keys(), ...inFlight]);
    const revisionsBefore = state().serverRevisions;
    const dropped = whileApplying(() => state().applyServerGrids(environmentId, records, skip));
    for (const id of dropped) {
      baseline.delete(id);
      cancelTimer(id);
    }
    const revisionsAfter = state().serverRevisions;
    for (const record of records) {
      if (revisionsAfter[record.id] !== revisionsBefore[record.id] || !baseline.has(record.id)) {
        baseline.set(record.id, serverContentKey(record));
      }
    }

    const onServer = new Set(records.map((record) => record.id));
    const localOnly = state().grids.filter(
      (grid) =>
        grid.environmentId === environmentId &&
        !onServer.has(grid.id) &&
        state().serverRevisions[grid.id] === undefined,
    );
    const firstUpload = records.length === 0 && !deps.importedEnvironments.has(environmentId);
    for (const grid of localOnly) {
      if (firstUpload || unsent.has(grid.id)) void push(grid.id);
    }
    if (firstUpload || records.length > 0) deps.importedEnvironments.add(environmentId);
    for (const id of localOnly) unsent.delete(id.id);

    for (const grid of state().grids) {
      if (grid.environmentId !== environmentId || skip.has(grid.id)) continue;
      const known = baseline.get(grid.id);
      if (known !== undefined && known !== serverContentKey(grid)) schedule(grid.id);
    }
  };

  const stopEnvironments = deps.watchConnectedEnvironments((environmentIds) => {
    const connected = new Set(environmentIds);
    for (const [environmentId, stop] of watchers) {
      if (connected.has(environmentId)) continue;
      stop();
      watchers.delete(environmentId);
      synced.delete(environmentId);
    }
    for (const environmentId of connected) {
      if (watchers.has(environmentId)) continue;
      watchers.set(
        environmentId,
        deps.watchServerGrids(environmentId, (snapshot) => onServerGrids(environmentId, snapshot)),
      );
    }
  });

  return () => {
    stopStore();
    stopEnvironments();
    for (const stop of watchers.values()) stop();
    for (const timer of timers.values()) clearTimeout(timer);
    watchers.clear();
    timers.clear();
  };
}

const errorText = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);
