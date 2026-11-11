import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "../lib/utils";
import { resolveStorage } from "../lib/storage";
import {
  type GridRecord,
  MAX_GRID_THREADS,
  addThreadToGrid,
  containsThreadId,
  createGridRecord as createGridRecordWith,
  gridById,
  gridsForWorkspace,
  moveThreadToGridRecords,
  parseGrids,
  pinGridRecord,
  placeThread,
  removeThreadFromGridRecord,
  renameGridRecord,
  replaceThreadDraft,
  setGridHiddenRecord,
  unpinGridRecord,
  updateGrid,
  withTree,
  workspaceKeyOf,
} from "@houston-app/shared/grid/record";
import type { HoustonGridRecord } from "@houston-app/contracts/houston/grids";
import { mergeServerRecord, reconcileServerGrids } from "./gridServerMerge";
import { sameProject } from "./projectMove";
import {
  type LayoutNode,
  type Side,
  type ThreadNode,
  type TidyShape,
  arrangeThreads,
  equalize,
  findThread,
  insertBeside,
  insertThreadAtSlot,
  isLayoutNode,
  moveThread,
  preorderThreads,
  reconcileThreads,
  removeThread,
  replaceThread,
  sameLayout,
  swapThread,
  threadLeaf,
  tidy,
} from "@houston-app/shared/grid/tree";

/** A thread that left a grid keeps the grid and pane slot it came from. */
export interface ThreadOrigin {
  gridId: string;
  slot: number;
}

export type ThreadOrigins = Readonly<Record<string, ThreadOrigin>>;

/** A cell the user closed from the grid, kept so Ctrl+Shift+T can put it back. */
export interface ClosedCell {
  threadId: string;
  slot: number;
  /** The exact tree before the close, so reopening restores its pane and sizes. */
  tree?: LayoutNode;
}

/** Per-grid stacks of closed cells, most recent last. */
export type ClosedCellsByGrid = Readonly<Record<string, readonly ClosedCell[]>>;

/** A small stack per grid: enough to undo a run of closes without unbounded state. */
export const MAX_CLOSED_CELLS_PER_GRID = 10;

export interface GridStoreState {
  grids: GridRecord[];
  /** The server revision each grid last had here; a grid without one was never uploaded. */
  serverRevisions: Readonly<Record<string, number>>;
  threadOrigins: ThreadOrigins;
  closedCells: ClosedCellsByGrid;
  createGrid: (input: {
    environmentId: string;
    projectId: string;
    workspaceKey: string;
    name?: string;
    id?: string;
    now?: string;
  }) => string;
  /**
   * Takes one environment's server grids into the store. `skip` names grids with an unconfirmed
   * local change. Returns the ids dropped because the server no longer has them.
   */
  applyServerGrids: (
    environmentId: string,
    records: ReadonlyArray<HoustonGridRecord>,
    skip: ReadonlySet<string>,
  ) => string[];
  /** Replaces one grid's server-owned fields with the server's copy, whatever its revision. */
  adoptServerGrid: (record: HoustonGridRecord) => void;
  /** Records a saved revision and the creation time the server assigned. */
  setServerRevision: (gridId: string, revision: number, createdAt: string) => void;
  renameGrid: (gridId: string, name: string) => void;
  deleteGrid: (gridId: string) => void;
  addThread: (gridId: string, threadId: string, draftId?: string) => void;
  /** Appends a thread to another grid of its own project; the menu and a sidebar drop share this path. */
  moveThreadToGrid: (input: {
    threadId: string;
    threadEnvironmentId: string;
    threadProjectId: string;
    targetGridId: string;
  }) => boolean;
  removeThreadFromGrid: (gridId: string, threadId: string) => void;
  setTree: (gridId: string, tree: LayoutNode | null) => void;
  /** Rebuilds the grid as a balanced grid, one row or one column; a grid with fewer than two threads is unchanged. */
  tidyGrid: (gridId: string, shape: TidyShape) => void;
  /** Resets every split in the grid to an even share without moving a pane. */
  equalizeGrid: (gridId: string) => void;
  focusThread: (gridId: string, threadId: string | null) => void;
  setGridPendingDraft: (
    gridId: string,
    pending: { draftId: string; threadId: string } | null,
  ) => void;
  setGridDetailsOpen: (gridId: string, open: boolean) => void;
  /** Pins the grid's right panel to `threadId`, or returns it to follow-focus with `null`. */
  setPanelPinnedThread: (gridId: string, threadId: string | null) => void;
  setDraftId: (gridId: string, threadId: string, draftId: string | null) => void;
  reconcileGridThreads: (gridId: string, threadIds: string[]) => void;
  pinGrid: (gridId: string, now?: string) => void;
  unpinGrid: (gridId: string) => void;
  setGridHidden: (gridId: string, hidden: boolean) => void;
  /** Swaps a grid with its visible neighbour in the same workspace and pin group, for the manual order. */
  moveGridInWorkspace: (gridId: string, direction: -1 | 1) => void;
  /** Swaps two panes so the dragged thread takes the target's place. */
  reorderGridThreads: (gridId: string, draggedThreadId: string, targetThreadId: string) => void;
  /**
   * Drops a thread onto a cell: the centre replaces it, an edge splits toward
   * that side. Returns false when the grid is full and the drop would add a cell.
   */
  moveThreadToCell: (input: {
    threadId: string;
    targetGridId: string;
    targetThreadId: string;
    side: Side;
    /** The thread's own project, for a thread no grid shows yet. */
    threadEnvironmentId?: string;
    threadProjectId?: string;
  }) => boolean;
  /** Reflows the grid to the automatic arrangement for its thread count. */
  autoArrangeGrid: (gridId: string) => void;
  /** Removes a held or closed thread from its grid, remembering where it sat. */
  detachThreadForShelf: (threadId: string) => void;
  /** Places a woken or reopened thread back in its origin grid, or a new one. */
  returnThreadToOrigin: (input: {
    threadId: string;
    environmentId: string;
    projectId: string;
  }) => string | null;
  /** Removes a cell and remembers its pane slot for a reopen. */
  closeGridCell: (gridId: string, threadId: string) => void;
  /** Puts the most recently closed cell back at its slot, or returns null. */
  reopenClosedCell: (gridId: string) => ClosedCell | null;
  /** Drops one closed cell that can no longer come back. */
  forgetClosedCell: (gridId: string, threadId: string) => void;
}

export const GRID_STORAGE_KEY = "houston:grids:v1";

export function gridContainingThread(
  grids: readonly GridRecord[],
  environmentId: string,
  threadId: string,
): GridRecord | null {
  return (
    grids.find(
      (grid) =>
        grid.environmentId === environmentId &&
        grid.tree !== null &&
        containsThreadId(grid.tree, threadId),
    ) ?? null
  );
}

export function gridContainingDraft(
  grids: readonly GridRecord[],
  draftId: string,
): GridRecord | null {
  return (
    grids.find(
      (grid) =>
        grid.tree !== null && preorderThreads(grid.tree).some((leaf) => leaf.draftId === draftId),
    ) ?? null
  );
}

/**
 * A workspace's grids in sidebar order: pinned grids first, each group in the
 * order the user created them. Status never reorders a grid.
 */
export function orderedGridsForWorkspace(
  grids: readonly GridRecord[],
  workspaceKey: string,
): GridRecord[] {
  return gridsForWorkspace(grids, workspaceKey).toSorted((left, right) => {
    const pinOrder = (right.pinnedAt !== null ? 1 : 0) - (left.pinnedAt !== null ? 1 : 0);
    if (pinOrder !== 0) return pinOrder;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  });
}

/**
 * The rail's order for a workspace's grids. Pinned grids lead in every order; "manual" keeps
 * the stored order, which moveGridInWorkspace changes; "updated_at" reads each grid's latest
 * thread activity from the caller, newest first.
 */
export function sidebarOrderedGrids(
  grids: readonly GridRecord[],
  workspaceKey: string,
  order: "updated_at" | "created_at" | "manual",
  activityAt: (grid: GridRecord) => number,
): GridRecord[] {
  if (order === "created_at") return orderedGridsForWorkspace(grids, workspaceKey);
  const pinRank = (grid: GridRecord) => (grid.pinnedAt !== null ? 0 : 1);
  const workspaceGrids = gridsForWorkspace(grids, workspaceKey);
  if (order === "manual") {
    return workspaceGrids.toSorted((left, right) => pinRank(left) - pinRank(right));
  }
  return workspaceGrids.toSorted(
    (left, right) =>
      pinRank(left) - pinRank(right) ||
      activityAt(right) - activityAt(left) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

export function parseThreadOrigins(value: unknown): Record<string, ThreadOrigin> {
  if (!value || typeof value !== "object") return {};
  const origins: Record<string, ThreadOrigin> = {};
  for (const [threadId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<ThreadOrigin>;
    if (typeof raw.gridId !== "string" || raw.gridId.length === 0) continue;
    if (typeof raw.slot !== "number" || !Number.isFinite(raw.slot) || raw.slot < 0) continue;
    origins[threadId] = { gridId: raw.gridId, slot: Math.trunc(raw.slot) };
  }
  return origins;
}

export function parseServerRevisions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const revisions: Record<string, number> = {};
  for (const [gridId, revision] of Object.entries(value as Record<string, unknown>)) {
    if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) {
      revisions[gridId] = revision;
    }
  }
  return revisions;
}

export function parseClosedCells(value: unknown): Record<string, ClosedCell[]> {
  if (!value || typeof value !== "object") return {};
  const stacks: Record<string, ClosedCell[]> = {};
  for (const [gridId, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const cells: ClosedCell[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const raw = entry as Partial<ClosedCell>;
      if (typeof raw.threadId !== "string" || raw.threadId.length === 0) continue;
      if (typeof raw.slot !== "number" || !Number.isFinite(raw.slot) || raw.slot < 0) continue;
      if (cells.some((cell) => cell.threadId === raw.threadId)) continue;
      const tree =
        raw.tree !== undefined && raw.tree !== null && isLayoutNode(raw.tree)
          ? raw.tree
          : undefined;
      cells.push({
        threadId: raw.threadId,
        slot: Math.trunc(raw.slot),
        ...(tree === undefined ? {} : { tree }),
      });
    }
    if (cells.length > 0) stacks[gridId] = cells.slice(-MAX_CLOSED_CELLS_PER_GRID);
  }
  return stacks;
}

function forgetClosedCellIn(
  closedCells: ClosedCellsByGrid,
  gridId: string,
  threadId: string,
): ClosedCellsByGrid {
  const stack = closedCells[gridId];
  if (stack === undefined || !stack.some((cell) => cell.threadId === threadId)) return closedCells;
  const next = stack.filter((cell) => cell.threadId !== threadId);
  if (next.length > 0) return { ...closedCells, [gridId]: next };
  const { [gridId]: _removed, ...rest } = closedCells;
  return rest;
}

function forgetClosedCellEverywhere(
  closedCells: ClosedCellsByGrid,
  threadId: string,
): ClosedCellsByGrid {
  const next: Record<string, ClosedCell[]> = {};
  let changed = false;
  for (const [gridId, stack] of Object.entries(closedCells)) {
    const kept = stack.filter((cell) => cell.threadId !== threadId);
    if (kept.length === stack.length) {
      next[gridId] = [...stack];
      continue;
    }
    changed = true;
    if (kept.length > 0) next[gridId] = kept;
  }
  return changed ? next : closedCells;
}

/** Records a close once, most recent last, and caps the stack per grid. */
export function recordClosedCell(
  closedCells: ClosedCellsByGrid,
  gridId: string,
  cell: ClosedCell,
): ClosedCellsByGrid {
  const current = (closedCells[gridId] ?? []).filter((entry) => entry.threadId !== cell.threadId);
  return {
    ...closedCells,
    [gridId]: [...current, cell].slice(-MAX_CLOSED_CELLS_PER_GRID),
  };
}

/**
 * Takes a thread out of the grid it is shown in and remembers that pane. An
 * action from outside any grid leaves the store untouched.
 */
export function detachThreadForShelf(
  grids: ReadonlyArray<GridRecord>,
  origins: ThreadOrigins,
  threadId: string,
): { grids: GridRecord[]; threadOrigins: ThreadOrigins } {
  const grid = grids.find(
    (candidate) => candidate.tree !== null && containsThreadId(candidate.tree, threadId),
  );
  if (grid === undefined || grid.tree === null)
    return { grids: [...grids], threadOrigins: origins };
  const slot = preorderThreads(grid.tree).findIndex((leaf) => leaf.threadId === threadId);
  return {
    grids: updateGrid(grids, grid.id, (candidate) =>
      withTree(candidate, candidate.tree === null ? null : removeThread(candidate.tree, threadId)),
    ),
    threadOrigins: { ...origins, [threadId]: { gridId: grid.id, slot: Math.max(0, slot) } },
  };
}

export interface ReturnedThread {
  readonly grids: GridRecord[];
  readonly threadOrigins: ThreadOrigins;
  readonly gridId: string | null;
}

function withoutOrigin(origins: ThreadOrigins, threadId: string): ThreadOrigins {
  const { [threadId]: _origin, ...rest } = origins;
  return rest;
}

/**
 * Puts a returning thread back in the pane it left. A missing, hidden or full
 * origin grid sends it to a new grid in the same workspace instead.
 */
export function returnThreadToOrigin(
  grids: ReadonlyArray<GridRecord>,
  origins: ThreadOrigins,
  input: {
    readonly threadId: string;
    readonly environmentId: string;
    readonly projectId: string;
    readonly now?: string;
  },
): ReturnedThread {
  const origin = origins[input.threadId];
  if (origin === undefined) return { grids: [...grids], threadOrigins: origins, gridId: null };
  const remaining = withoutOrigin(origins, input.threadId);
  const current = grids.find(
    (grid) => grid.tree !== null && containsThreadId(grid.tree, input.threadId),
  );
  if (current !== undefined) {
    return { grids: [...grids], threadOrigins: remaining, gridId: current.id };
  }
  const originGrid = gridById(grids, origin.gridId);
  const originCount =
    originGrid?.tree === null || originGrid === null ? 0 : preorderThreads(originGrid.tree).length;
  if (originGrid !== null && !originGrid.hidden && originCount < MAX_GRID_THREADS) {
    return {
      grids: updateGrid(grids, originGrid.id, (grid) =>
        withTree(grid, insertThreadAtSlot(grid.tree, threadLeaf(input.threadId), origin.slot)),
      ),
      threadOrigins: remaining,
      gridId: originGrid.id,
    };
  }
  const workspaceKey = workspaceKeyOf(input.environmentId, input.projectId);
  const created = createGridRecord(grids, {
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceKey,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return {
    grids: [...grids, addThreadToGrid(created, input.threadId)],
    threadOrigins: remaining,
    gridId: created.id,
  };
}

export {
  type GridRecord,
  MAX_GRID_THREADS,
  addThreadToGrid,
  gridById,
  gridsForWorkspace,
  parseGrids,
  workspaceKeyOf,
};

export function createGridRecord(
  grids: readonly GridRecord[],
  input: {
    environmentId: string;
    projectId: string;
    workspaceKey: string;
    name?: string;
    id?: string;
    now?: string;
  },
): GridRecord {
  return createGridRecordWith(grids, {
    ...input,
    id: input.id ?? randomUUID(),
    now: input.now ?? new Date().toISOString(),
  });
}

export const useGridStore = create<GridStoreState>()(
  persist(
    (set, get) => ({
      grids: [],
      serverRevisions: {},
      threadOrigins: {},
      closedCells: {},
      applyServerGrids: (environmentId, records, skip) => {
        const state = get();
        const reconciled = reconcileServerGrids({
          grids: state.grids,
          serverRevisions: state.serverRevisions,
          environmentId,
          records,
          skip,
        });
        if (reconciled.grids === state.grids) return reconciled.droppedIds;
        let closedCells = state.closedCells;
        for (const id of reconciled.droppedIds) {
          const { [id]: _stack, ...rest } = closedCells;
          closedCells = rest;
        }
        set({
          grids: reconciled.grids,
          serverRevisions: reconciled.serverRevisions,
          closedCells,
        });
        return reconciled.droppedIds;
      },
      adoptServerGrid: (record) =>
        set((state) => ({
          serverRevisions: { ...state.serverRevisions, [record.id]: record.revision },
          grids: state.grids.some((grid) => grid.id === record.id)
            ? updateGrid(state.grids, record.id, (grid) => mergeServerRecord(grid, record))
            : [...state.grids, mergeServerRecord(undefined, record)],
        })),
      setServerRevision: (gridId, revision, createdAt) =>
        set((state) => ({
          serverRevisions: { ...state.serverRevisions, [gridId]: revision },
          grids: updateGrid(state.grids, gridId, (grid) =>
            grid.createdAt === createdAt ? grid : { ...grid, createdAt },
          ),
        })),
      createGrid: (input) => {
        const grid = createGridRecord(get().grids, input);
        set((state) => ({ grids: [...state.grids, grid] }));
        return grid.id;
      },
      renameGrid: (gridId, name) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => renameGridRecord(grid, name)),
        })),
      deleteGrid: (gridId) =>
        set((state) => {
          const { [gridId]: _stack, ...closedCells } = state.closedCells;
          const { [gridId]: _revision, ...serverRevisions } = state.serverRevisions;
          return {
            grids: state.grids.filter((grid) => grid.id !== gridId),
            closedCells,
            serverRevisions,
          };
        }),
      addThread: (gridId, threadId, draftId) =>
        set((state) => {
          const placed = placeThread(state.grids, {
            gridId,
            threadId,
            ...(draftId === undefined ? {} : { draftId }),
          });
          if (!placed.ok) return state;
          return {
            grids: placed.grids,
            closedCells: forgetClosedCellEverywhere(state.closedCells, threadId),
          };
        }),
      moveThreadToGrid: (input) => {
        const placed = moveThreadToGridRecords(get().grids, input);
        if (!placed.ok) return false;
        set((state) => ({
          grids: placed.grids,
          closedCells: forgetClosedCellEverywhere(state.closedCells, input.threadId),
        }));
        return true;
      },
      removeThreadFromGrid: (gridId, threadId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            removeThreadFromGridRecord(grid, threadId),
          ),
        })),
      setTree: (gridId, tree) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => withTree(grid, tree)),
        })),
      tidyGrid: (gridId, shape) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            grid.tree === null || preorderThreads(grid.tree).length < 2
              ? grid
              : withTree(grid, tidy(grid.tree, shape)),
          ),
        })),
      equalizeGrid: (gridId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            grid.tree === null || preorderThreads(grid.tree).length < 2
              ? grid
              : withTree(grid, equalize(grid.tree)),
          ),
        })),
      focusThread: (gridId, threadId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => ({
            ...grid,
            focusedThreadId:
              threadId !== null && containsThreadId(grid.tree, threadId)
                ? threadId
                : grid.focusedThreadId,
          })),
        })),
      setGridPendingDraft: (gridId, pending) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => {
            if (pending === null) {
              if (grid.pendingDraft == null) return grid;
              const { pendingDraft: _pending, ...rest } = grid;
              return rest;
            }
            return { ...grid, pendingDraft: pending };
          }),
        })),
      setGridDetailsOpen: (gridId, open) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => {
            if ((grid.detailsOpen === true) === open) return grid;
            if (open) return { ...grid, detailsOpen: true };
            const { detailsOpen: _closed, ...rest } = grid;
            return rest;
          }),
        })),
      setPanelPinnedThread: (gridId, threadId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => {
            if (threadId === null) {
              if (grid.panelPinnedThreadId === undefined) return grid;
              const { panelPinnedThreadId: _unpinned, ...rest } = grid;
              return rest;
            }
            if (!containsThreadId(grid.tree, threadId) || grid.panelPinnedThreadId === threadId) {
              return grid;
            }
            return { ...grid, panelPinnedThreadId: threadId };
          }),
        })),
      setDraftId: (gridId, threadId, draftId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => ({
            ...grid,
            tree: replaceThreadDraft(grid.tree, threadId, draftId),
          })),
        })),
      reconcileGridThreads: (gridId, threadIds) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            withTree(grid, reconcileThreads(grid.tree, threadIds)),
          ),
        })),
      pinGrid: (gridId, now) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            pinGridRecord(grid, now ?? new Date().toISOString()),
          ),
        })),
      unpinGrid: (gridId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, unpinGridRecord),
        })),
      setGridHidden: (gridId, hidden) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => setGridHiddenRecord(grid, hidden)),
        })),
      moveGridInWorkspace: (gridId, direction) =>
        set((state) => ({ grids: moveGridAmongSiblings(state.grids, gridId, direction) })),
      reorderGridThreads: (gridId, draggedThreadId, targetThreadId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            grid.tree === null
              ? grid
              : withTree(grid, swapThread(grid.tree, draggedThreadId, targetThreadId)),
          ),
        })),
      moveThreadToCell: (input) => {
        const state = get();
        const target = gridById(state.grids, input.targetGridId);
        if (target === null || target.tree === null) return false;
        if (findThread(target.tree, input.targetThreadId) === null) return false;
        const sourceInTarget = findThread(target.tree, input.threadId) !== null;
        if (
          input.side !== "center" &&
          !sourceInTarget &&
          preorderThreads(target.tree).length >= MAX_GRID_THREADS
        ) {
          return false;
        }
        let grids = state.grids;
        const sourceGrid = grids.find(
          (grid) => grid.tree !== null && findThread(grid.tree, input.threadId) !== null,
        );
        // A thread never leaves its project; a cell's ref is built from the
        // target grid's environment, so a cross-project drop would be wrong too.
        const threadOwner =
          input.threadEnvironmentId !== undefined && input.threadProjectId !== undefined
            ? {
                environmentId: input.threadEnvironmentId,
                projectId: input.threadProjectId,
              }
            : sourceGrid;
        if (threadOwner !== undefined && !sameProject(threadOwner, target)) {
          return false;
        }
        if (sourceGrid !== undefined && sourceGrid.id !== target.id) {
          grids = updateGrid(grids, sourceGrid.id, (grid) =>
            withTree(grid, grid.tree === null ? null : removeThread(grid.tree, input.threadId)),
          );
        }
        const current = gridById(grids, target.id);
        if (current === null || current.tree === null) return false;
        const nextTree =
          input.side === "center"
            ? sourceInTarget
              ? (swapThread(current.tree, input.threadId, input.targetThreadId) ?? current.tree)
              : replaceThread(current.tree, input.targetThreadId, threadLeaf(input.threadId))
            : sourceInTarget
              ? moveThread(current.tree, input.threadId, input.targetThreadId, input.side)
              : insertBeside(
                  current.tree,
                  input.targetThreadId,
                  threadLeaf(input.threadId),
                  input.side,
                );
        set({
          grids: updateGrid(grids, target.id, (grid) => ({
            ...withTree(grid, nextTree),
            focusedThreadId: input.threadId,
          })),
          closedCells: forgetClosedCellEverywhere(state.closedCells, input.threadId),
        });
        return true;
      },
      autoArrangeGrid: (gridId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => {
            if (grid.tree === null) return grid;
            return withTree(grid, arrangeThreads(grid.tree));
          }),
        })),
      detachThreadForShelf: (threadId) =>
        set((state) => detachThreadForShelf(state.grids, state.threadOrigins, threadId)),
      returnThreadToOrigin: (input) => {
        const returned = returnThreadToOrigin(get().grids, get().threadOrigins, input);
        set({ grids: returned.grids, threadOrigins: returned.threadOrigins });
        return returned.gridId;
      },
      closeGridCell: (gridId, threadId) =>
        set((state) => {
          const grid = gridById(state.grids, gridId);
          if (grid === null || grid.tree === null) return state;
          const leaves = preorderThreads(grid.tree);
          const slot = leaves.findIndex((leaf) => leaf.threadId === threadId);
          if (slot < 0) return state;
          const leaf = leaves[slot]!;
          const previousTree = grid.tree;
          const tree = removeThread(previousTree, threadId);
          return {
            grids: updateGrid(state.grids, gridId, (current) => withTree(current, tree)),
            closedCells:
              leaf.draftId === undefined
                ? recordClosedCell(state.closedCells, gridId, {
                    threadId,
                    slot,
                    tree: previousTree,
                  })
                : state.closedCells,
          };
        }),
      reopenClosedCell: (gridId) => {
        const state = get();
        const stack = state.closedCells[gridId] ?? [];
        const cell = stack.at(-1);
        if (cell === undefined || gridById(state.grids, gridId) === null) return null;
        set((state) => {
          const grid = gridById(state.grids, gridId);
          if (grid === null) return state;
          const closedCells = forgetClosedCellIn(state.closedCells, gridId, cell.threadId);
          if (grid.tree !== null && containsThreadId(grid.tree, cell.threadId)) {
            return {
              ...state,
              closedCells,
              grids: updateGrid(state.grids, gridId, (current) => ({
                ...current,
                focusedThreadId: cell.threadId,
              })),
            };
          }
          const previousTree = cell.tree;
          const tree =
            previousTree !== undefined &&
            sameLayout(grid.tree, removeThread(previousTree, cell.threadId))
              ? previousTree
              : insertThreadAtSlot(grid.tree, threadLeaf(cell.threadId), cell.slot);
          return {
            ...state,
            closedCells,
            grids: updateGrid(state.grids, gridId, (current) => ({
              ...withTree(current, tree),
              focusedThreadId: cell.threadId,
            })),
          };
        });
        return cell;
      },
      forgetClosedCell: (gridId, threadId) =>
        set((state) => ({
          closedCells: forgetClosedCellIn(state.closedCells, gridId, threadId),
        })),
    }),
    {
      name: GRID_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 3,
      migrate: (persisted) => {
        const state = persisted as Partial<GridStoreState> | null;
        return {
          grids: parseGrids(state?.grids),
          serverRevisions: parseServerRevisions(state?.serverRevisions),
          threadOrigins: parseThreadOrigins(state?.threadOrigins),
          closedCells: parseClosedCells(state?.closedCells),
        };
      },
      partialize: ({ grids, serverRevisions, threadOrigins, closedCells }) => ({
        grids,
        serverRevisions,
        threadOrigins,
        closedCells,
      }),
    },
  ),
);

export function moveGridAmongSiblings(
  grids: readonly GridRecord[],
  gridId: string,
  direction: -1 | 1,
): GridRecord[] {
  const grid = grids.find((entry) => entry.id === gridId);
  if (grid === undefined) return [...grids];
  const pinned = grid.pinnedAt !== null;
  const siblings = sidebarOrderedGrids(grids, grid.workspaceKey, "manual", () => 0).filter(
    (entry) => !entry.hidden && (entry.pinnedAt !== null) === pinned,
  );
  const neighbour = siblings[siblings.findIndex((entry) => entry.id === gridId) + direction];
  if (neighbour === undefined) return [...grids];
  const from = grids.indexOf(grid);
  const to = grids.indexOf(neighbour);
  const next = [...grids];
  next[from] = neighbour;
  next[to] = grid;
  return next;
}

export function useGrid(gridId: string | null) {
  return useGridStore((state) => (gridId === null ? null : gridById(state.grids, gridId)));
}

export function threadLeavesOf(grid: GridRecord | null): ThreadNode[] {
  return grid === null ? [] : preorderThreads(grid.tree);
}
