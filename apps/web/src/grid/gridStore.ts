import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "../lib/utils";
import { resolveStorage } from "../lib/storage";
import {
  type LayoutNode,
  type ThreadNode,
  appendThread,
  arrangeThreads,
  gridPreset,
  insertThreadAtSlot,
  isGridPreset,
  isLayoutNode,
  preorderThreads,
  reconcileThreads,
  removeThread,
  swapThread,
  threadLeaf,
} from "./tree";

/** A thread that left a grid keeps the grid and pane slot it came from. */
export interface ThreadOrigin {
  gridId: string;
  slot: number;
}

export type ThreadOrigins = Readonly<Record<string, ThreadOrigin>>;

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
  /** Pinned grids sort above their workspace's other grids. */
  pinnedAt: string | null;
  /** Hidden grids keep their threads but drop out of the workspace tree. */
  hidden: boolean;
  createdAt: string;
}

export interface GridStoreState {
  grids: GridRecord[];
  threadOrigins: ThreadOrigins;
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
  setDraftId: (gridId: string, threadId: string, draftId: string | null) => void;
  reconcileGridThreads: (gridId: string, threadIds: string[]) => void;
  pinGrid: (gridId: string, now?: string) => void;
  unpinGrid: (gridId: string) => void;
  setGridHidden: (gridId: string, hidden: boolean) => void;
  /** Swaps two panes so the dragged thread takes the target's place. */
  reorderGridThreads: (gridId: string, draggedThreadId: string, targetThreadId: string) => void;
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
        set((state) => ({ grids: state.grids.filter((grid) => grid.id !== gridId) })),
      addThread: (gridId, threadId, draftId) =>
        set((state) => ({
          grids: updateGrid(state.grids, gridId, (grid) =>
            addThreadToGrid(grid, threadId, draftId),
          ),
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
    }),
    {
      name: GRID_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<GridStoreState> | null;
        return {
          grids: parseGrids(state?.grids),
          threadOrigins: parseThreadOrigins(state?.threadOrigins),
        };
      },
      partialize: ({ grids, threadOrigins }) => ({ grids, threadOrigins }),
    },
  ),
);

export function useGrid(gridId: string | null) {
  return useGridStore((state) => (gridId === null ? null : gridById(state.grids, gridId)));
}

export function threadLeavesOf(grid: GridRecord | null): ThreadNode[] {
  return grid === null ? [] : preorderThreads(grid.tree);
}
