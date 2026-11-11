import type { HoustonGridRecord } from "@houston-app/contracts/houston/grids";
import { withTree } from "@houston-app/shared/grid/record";

import type { GridRecord } from "@houston-app/shared/grid/record";

/**
 * Takes a server grid into the local one. The server owns the name, tree, pin, hidden flag and
 * creation time; focus, the pending draft and the open panels belong to this window and stay.
 * Focus follows the tree when the server removed the focused thread.
 */
export function mergeServerRecord(
  local: GridRecord | undefined,
  server: HoustonGridRecord,
): GridRecord {
  const base: GridRecord = {
    ...(local ?? { focusedThreadId: null }),
    id: server.id,
    name: server.name,
    environmentId: server.environmentId,
    projectId: server.projectId,
    workspaceKey: server.workspaceKey,
    tree: local?.tree ?? null,
    pinnedAt: server.pinnedAt,
    hidden: server.hidden,
    createdAt: server.createdAt,
  };
  return withTree(base, server.tree);
}

type ServerOwned = Pick<GridRecord, "name" | "pinnedAt" | "hidden"> & {
  readonly tree: GridRecord["tree"] | HoustonGridRecord["tree"];
};

/**
 * The server-owned content of a grid as a string, so a local change and the server's copy can be
 * compared. Revision, timestamps and the creation time are left out: the server sets them.
 */
export function serverContentKey(grid: ServerOwned): string {
  return JSON.stringify([grid.name, grid.tree, grid.pinnedAt, grid.hidden]);
}

/** The record a put sends for a local grid. */
export function toServerRecord(
  grid: GridRecord,
  revision: number,
  updatedAt: string,
): HoustonGridRecord {
  return {
    id: grid.id,
    environmentId: grid.environmentId,
    projectId: grid.projectId,
    workspaceKey: grid.workspaceKey,
    name: grid.name,
    tree: grid.tree,
    pinnedAt: grid.pinnedAt,
    hidden: grid.hidden,
    createdAt: grid.createdAt,
    revision,
    updatedAt,
  };
}

export interface ReconcileInput {
  readonly grids: GridRecord[];
  /** The server revision each synced grid last had here, by grid id. */
  readonly serverRevisions: Readonly<Record<string, number>>;
  readonly environmentId: string;
  readonly records: ReadonlyArray<HoustonGridRecord>;
  /** Grids with a local change not yet confirmed; the server's copy must not overwrite them. */
  readonly skip: ReadonlySet<string>;
}

export interface Reconciled {
  readonly grids: GridRecord[];
  readonly serverRevisions: Readonly<Record<string, number>>;
  /** Grids the server no longer has. */
  readonly droppedIds: string[];
}

/**
 * Brings one environment's grids in line with the server's list. A grid the server has replaces
 * the local copy when its revision is newer; a grid this window synced before and the server no
 * longer lists was deleted there; a grid the server never saw stays for the caller to upload.
 */
export function reconcileServerGrids(input: ReconcileInput): Reconciled {
  const byId = new Map(input.records.map((record) => [record.id, record] as const));
  const serverRevisions = { ...input.serverRevisions };
  const droppedIds: string[] = [];
  const grids: GridRecord[] = [];
  let changed = false;
  for (const grid of input.grids) {
    if (grid.environmentId !== input.environmentId) {
      grids.push(grid);
      continue;
    }
    const record = byId.get(grid.id);
    if (record === undefined) {
      if (!input.skip.has(grid.id) && serverRevisions[grid.id] !== undefined) {
        delete serverRevisions[grid.id];
        droppedIds.push(grid.id);
        changed = true;
        continue;
      }
      grids.push(grid);
      continue;
    }
    byId.delete(grid.id);
    const known = serverRevisions[grid.id];
    if (input.skip.has(grid.id) || (known !== undefined && known >= record.revision)) {
      grids.push(grid);
      continue;
    }
    serverRevisions[grid.id] = record.revision;
    grids.push(mergeServerRecord(grid, record));
    changed = true;
  }
  for (const record of byId.values()) {
    serverRevisions[record.id] = record.revision;
    grids.push(mergeServerRecord(undefined, record));
    changed = true;
  }
  // An event that changes nothing here keeps the store's arrays, so no subscriber re-renders
  // and no cache write follows.
  return changed
    ? { grids, serverRevisions, droppedIds }
    : { grids: input.grids, serverRevisions: input.serverRevisions, droppedIds };
}
