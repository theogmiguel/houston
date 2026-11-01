import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "../lib/utils";
import { resolveStorage } from "../lib/storage";
import {
  type LayoutNode,
  type Side,
  type ThreadNode,
  appendThread,
  arrangeThreads,
  findThread,
  gridPreset,
  insertBeside,
  insertThreadAtSlot,
  isGridPreset,
  isLayoutNode,
  moveThread,
  preorderThreads,
  reconcileThreads,
  removeThread,
  replaceThread,
  sameLayout,
  swapThread,
  threadLeaf,
} from "./tree";

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

/** The most threads a grid can show before a returning thread needs a new one. */
export const MAX_GRID_THREADS = 6;

/**
 * A grid is a named layout of threads inside one workspace. It is renderer state:
 * localStorage only, never the server or the wire protocol.
 */
export interface GridRecord {
  id: string;
  name: string;
  environmentId: string;
  projectId: string;
  workspaceKey: string;
  tree: LayoutNode | null;
  focusedThreadId: string | null;
  /** The grid's one thread-details flag; the focused cell shows its card while set. */
  detailsOpen?: boolean;
  /** Pinned grids sort above their workspace's other grids. */
  pinnedAt: string | null;
  /** Hidden grids keep their threads but drop out of the workspace tree. */
  hidden: boolean;
  createdAt: string;
}

export interface GridStoreState {
  grids: GridRecord[];
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
  renameGrid: (gridId: string, name: string) => void;
  deleteGrid: (gridId: string) => void;
  addThread: (gridId: string, threadId: string, draftId?: string) => void;
  removeThreadFromGrid: (gridId: string, threadId: string) => void;
  setTree: (gridId: string, tree: LayoutNode | null) => void;
  focusThread: (gridId: string, threadId: string | null) => void;
  setGridDetailsOpen: (gridId: string, open: boolean) => void;
  setDraftId: (gridId: string, threadId: string, draftId: string | null) => void;
  reconcileGridThreads: (gridId: string, threadIds: string[]) => void;
  pinGrid: (gridId: string, now?: string) => void;
  unpinGrid: (gridId: string) => void;
  setGridHidden: (gridId: string, hidden: boolean) => void;
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

export function workspaceKeyOf(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

export function gridsForWorkspace(
  grids: readonly GridRecord[],
  workspaceKey: string,
): GridRecord[] {
  return grids.filter((grid) => grid.workspaceKey === workspaceKey);
}

export function gridById(grids: readonly GridRecord[], gridId: string): GridRecord | null {
  return grids.find((grid) => grid.id === gridId) ?? null;
}

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

function nextGridName(grids: readonly GridRecord[], workspaceKey: string): string {
  const names = new Set(
    gridsForWorkspace(grids, workspaceKey).map((grid) => grid.name.toLowerCase()),
  );
  let n = 1;
  while (names.has(`grid ${n}`)) n += 1;
  return `Grid ${n}`;
}

function defaultFocus(tree: LayoutNode | null): string | null {
  return tree === null ? null : (preorderThreads(tree)[0]?.threadId ?? null);
}

function updateGrid(
  grids: readonly GridRecord[],
  gridId: string,
  update: (grid: GridRecord) => GridRecord,
): GridRecord[] {
  return grids.map((grid) => (grid.id === gridId ? update(grid) : grid));
}

function withTree(grid: GridRecord, tree: LayoutNode | null): GridRecord {
  const focusedThreadId =
    grid.focusedThreadId !== null && tree !== null && containsThreadId(tree, grid.focusedThreadId)
      ? grid.focusedThreadId
      : defaultFocus(tree);
  return { ...grid, tree, focusedThreadId };
}

function containsThreadId(tree: LayoutNode | null, threadId: string): boolean {
  return tree !== null && preorderThreads(tree).some((leaf) => leaf.threadId === threadId);
}

function replaceThreadDraft(
  tree: LayoutNode | null,
  threadId: string,
  draftId: string | null,
): LayoutNode | null {
  if (tree === null) return null;
  if (tree.kind === "thread") {
    if (tree.threadId !== threadId) return tree;
    const { draftId: _draftId, ...rest } = tree;
    return draftId === null ? rest : { ...rest, draftId };
  }
  return {
    ...tree,
    children: tree.children.map((child) => replaceThreadDraft(child, threadId, draftId)!),
  };
}

function parseGrid(value: unknown): GridRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<GridRecord>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.environmentId !== "string" ||
    typeof raw.projectId !== "string" ||
    typeof raw.workspaceKey !== "string"
  ) {
    return null;
  }
  if (raw.tree !== null && raw.tree !== undefined && !isLayoutNode(raw.tree)) return null;
  const tree = raw.tree ?? null;
  return {
    id: raw.id,
    name: raw.name,
    environmentId: raw.environmentId,
    projectId: raw.projectId,
    workspaceKey: raw.workspaceKey,
    tree,
    focusedThreadId:
      typeof raw.focusedThreadId === "string" && containsThreadId(tree, raw.focusedThreadId)
        ? raw.focusedThreadId
        : defaultFocus(tree),
    ...(raw.detailsOpen === true ? { detailsOpen: true as const } : {}),
    pinnedAt: typeof raw.pinnedAt === "string" ? raw.pinnedAt : null,
    hidden: raw.hidden === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
  };
}

export function parseGrids(value: unknown): GridRecord[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const grids: GridRecord[] = [];
  for (const entry of value) {
    const grid = parseGrid(entry);
    if (grid === null || seen.has(grid.id)) continue;
    seen.add(grid.id);
    grids.push(grid);
  }
  return grids;
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
  return {
    id: input.id ?? randomUUID(),
    name: input.name?.trim() || nextGridName(grids, input.workspaceKey),
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceKey: input.workspaceKey,
    tree: null,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function addThreadPreservingLayout(
  tree: LayoutNode | null,
  threadId: string,
  previousIds: readonly string[],
): LayoutNode {
  if (tree === null) return gridPreset([threadId]) ?? threadLeaf(threadId);
  // A grid that is still on its automatic arrangement keeps following the
  // presets as it fills; a layout the user split or dragged keeps its shape.
  if (isGridPreset(tree, previousIds)) {
    return gridPreset([...previousIds, threadId]) ?? appendThread(tree, threadId);
  }
  return appendThread(tree, threadId);
}

export function addThreadToGrid(grid: GridRecord, threadId: string, draftId?: string): GridRecord {
  const existing = grid.tree === null ? [] : preorderThreads(grid.tree);
  if (existing.some((leaf) => leaf.threadId === threadId)) {
    const withDraft =
      draftId === undefined ? grid.tree : replaceThreadDraft(grid.tree, threadId, draftId);
    return { ...withTree(grid, withDraft), focusedThreadId: threadId };
  }
  const previousIds = existing.map((leaf) => leaf.threadId);
  const tree = addThreadPreservingLayout(grid.tree, threadId, previousIds);
  const withDraft = draftId === undefined ? tree : replaceThreadDraft(tree, threadId, draftId);
  return { ...withTree(grid, withDraft), focusedThreadId: threadId };
}

export const useGridStore = create<GridStoreState>()(
  persist(
    (set, get) => ({
      grids: [],
      threadOrigins: {},
      closedCells: {},
      createGrid: (input) => {
        const grid = createGridRecord(get().grids, input);
        set((state) => ({ grids: [...state.grids, grid] }));
        return grid.id;
      },
      renameGrid: (gridId, name) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => ({
            ...grid,
            name: name.trim() || grid.name,
          })),
        })),
      deleteGrid: (gridId) =>
        set((state) => {
          const { [gridId]: _stack, ...closedCells } = state.closedCells;
          return {
            grids: state.grids.filter((grid) => grid.id !== gridId),
            closedCells,
          };
        }),
      addThread: (gridId, threadId, draftId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            addThreadToGrid(grid, threadId, draftId),
          ),
          closedCells: forgetClosedCellEverywhere(state.closedCells, threadId),
        })),
      removeThreadFromGrid: (gridId, threadId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            withTree(grid, grid.tree === null ? null : removeThread(grid.tree, threadId)),
          ),
        })),
      setTree: (gridId, tree) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => withTree(grid, tree)),
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
      setGridDetailsOpen: (gridId, open) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => {
            if ((grid.detailsOpen === true) === open) return grid;
            if (open) return { ...grid, detailsOpen: true };
            const { detailsOpen: _closed, ...rest } = grid;
            return rest;
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
          grids: updateGrid(state.grids, gridId, (grid) => ({
            ...grid,
            pinnedAt: grid.pinnedAt ?? now ?? new Date().toISOString(),
          })),
        })),
      unpinGrid: (gridId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => ({ ...grid, pinnedAt: null })),
        })),
      setGridHidden: (gridId, hidden) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) => ({ ...grid, hidden })),
        })),
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
          threadOrigins: parseThreadOrigins(state?.threadOrigins),
          closedCells: parseClosedCells(state?.closedCells),
        };
      },
      partialize: ({ grids, threadOrigins, closedCells }) => ({
        grids,
        threadOrigins,
        closedCells,
      }),
    },
  ),
);

export function useGrid(gridId: string | null) {
  return useGridStore((state) => (gridId === null ? null : gridById(state.grids, gridId)));
}

export function threadLeavesOf(grid: GridRecord | null): ThreadNode[] {
  return grid === null ? [] : preorderThreads(grid.tree);
}
