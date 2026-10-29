import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { randomUUID } from "../lib/utils";
import { resolveStorage } from "../lib/storage";
import {
  type LayoutNode,
  type ThreadNode,
  appendThread,
  isLayoutNode,
  preorderThreads,
  reconcileThreads,
  removeThread,
  threadLeaf,
} from "./tree";

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
  createdAt: string;
}

export interface GridStoreState {
  grids: GridRecord[];
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
}

export const GRID_STORAGE_KEY = "houston:grids:v1";

export function gridsForWorkspace(grids: readonly GridRecord[], workspaceKey: string): GridRecord[] {
  return grids.filter((grid) => grid.workspaceKey === workspaceKey);
}

export function gridById(grids: readonly GridRecord[], gridId: string): GridRecord | null {
  return grids.find((grid) => grid.id === gridId) ?? null;
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
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function addThreadToGrid(
  grid: GridRecord,
  threadId: string,
  draftId?: string,
): GridRecord {
  const existing = grid.tree === null ? [] : preorderThreads(grid.tree);
  const tree =
    existing.some((leaf) => leaf.threadId === threadId) || grid.tree === null
      ? grid.tree === null
        ? threadLeaf(threadId, undefined, draftId)
        : grid.tree
      : appendThread(grid.tree, threadId);
  const withDraft =
    draftId === undefined ? tree : replaceThreadDraft(tree, threadId, draftId);
  return { ...withTree(grid, withDraft), focusedThreadId: threadId };
}

export const useGridStore = create<GridStoreState>()(
  persist(
    (set, get) => ({
      grids: [],
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
    }),
    {
      name: GRID_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: (persisted) => ({
        grids: parseGrids((persisted as Partial<GridStoreState> | null)?.grids),
      }),
      partialize: ({ grids }) => ({ grids }),
    },
  ),
);

export function useGrid(gridId: string | null) {
  return useGridStore((state) => (gridId === null ? null : gridById(state.grids, gridId)));
}

export function threadLeavesOf(grid: GridRecord | null): ThreadNode[] {
  return grid === null ? [] : preorderThreads(grid.tree);
}
