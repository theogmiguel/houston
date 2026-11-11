import {
  type LayoutNode,
  appendThread,
  gridPreset,
  isGridPreset,
  isLayoutNode,
  preorderThreads,
  removeThread,
  threadLeaf,
} from "./tree";

/** The most threads a grid can show before a returning thread needs a new one. */
export const MAX_GRID_THREADS = 6;

export interface ProjectOwner {
  readonly environmentId: string;
  readonly projectId: string;
}

/** A thread belongs to one project in one environment; a grid belongs to exactly one. */
export function sameProject(left: ProjectOwner, right: ProjectOwner): boolean {
  return left.environmentId === right.environmentId && left.projectId === right.projectId;
}

/** A grid is a named layout of threads inside one workspace (one project in one environment). */
export interface GridRecord {
  id: string;
  name: string;
  environmentId: string;
  projectId: string;
  workspaceKey: string;
  tree: LayoutNode | null;
  focusedThreadId: string | null;
  /** The draft an empty grid shows before its first send; it names the thread so it is placed once. */
  pendingDraft?: { draftId: string; threadId: string } | null;
  /** The grid's one thread-details flag; the focused cell shows its card while set. */
  detailsOpen?: boolean;
  /** The thread whose right panel stays shown whichever cell is focused; absent while it follows focus. */
  panelPinnedThreadId?: string;
  /** Pinned grids sort above their workspace's other grids. */
  pinnedAt: string | null;
  /** Hidden grids keep their threads but drop out of the workspace tree. */
  hidden: boolean;
  createdAt: string;
}

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

export function containsThreadId(tree: LayoutNode | null, threadId: string): boolean {
  return tree !== null && preorderThreads(tree).some((leaf) => leaf.threadId === threadId);
}

export function gridThreadCount(grid: Pick<GridRecord, "tree">): number {
  return grid.tree === null ? 0 : preorderThreads(grid.tree).length;
}

export function nextGridName(grids: readonly GridRecord[], workspaceKey: string): string {
  const names = new Set(
    gridsForWorkspace(grids, workspaceKey).map((grid) => grid.name.toLowerCase()),
  );
  let n = 1;
  while (names.has(`grid ${n}`)) n += 1;
  return `Grid ${n}`;
}

export function defaultFocus(tree: LayoutNode | null): string | null {
  return tree === null ? null : (preorderThreads(tree)[0]?.threadId ?? null);
}

export function updateGrid(
  grids: readonly GridRecord[],
  gridId: string,
  update: (grid: GridRecord) => GridRecord,
): GridRecord[] {
  return grids.map((grid) => (grid.id === gridId ? update(grid) : grid));
}

/** Sets the tree and keeps focus and the pinned panel on threads the tree still has. */
export function withTree(grid: GridRecord, tree: LayoutNode | null): GridRecord {
  const focusedThreadId =
    grid.focusedThreadId !== null && tree !== null && containsThreadId(tree, grid.focusedThreadId)
      ? grid.focusedThreadId
      : defaultFocus(tree);
  const { panelPinnedThreadId, ...rest } = grid;
  const keepsPin =
    panelPinnedThreadId !== undefined &&
    tree !== null &&
    containsThreadId(tree, panelPinnedThreadId);
  return {
    ...rest,
    tree,
    focusedThreadId,
    ...(keepsPin ? { panelPinnedThreadId } : {}),
  };
}

export interface CreateGridInput {
  environmentId: string;
  projectId: string;
  workspaceKey: string;
  name?: string;
  id: string;
  now: string;
}

/** A new empty grid; a blank name takes the workspace's next free "Grid N". */
export function createGridRecord(grids: readonly GridRecord[], input: CreateGridInput): GridRecord {
  return {
    id: input.id,
    name: input.name?.trim() || nextGridName(grids, input.workspaceKey),
    environmentId: input.environmentId,
    projectId: input.projectId,
    workspaceKey: input.workspaceKey,
    tree: null,
    focusedThreadId: null,
    pinnedAt: null,
    hidden: false,
    createdAt: input.now,
  };
}

/** A blank name keeps the current one. */
export function renameGridRecord(grid: GridRecord, name: string): GridRecord {
  return { ...grid, name: name.trim() || grid.name };
}

export function setGridHiddenRecord(grid: GridRecord, hidden: boolean): GridRecord {
  return { ...grid, hidden };
}

/** Pinning an already pinned grid keeps its original pin time. */
export function pinGridRecord(grid: GridRecord, now: string): GridRecord {
  return { ...grid, pinnedAt: grid.pinnedAt ?? now };
}

export function unpinGridRecord(grid: GridRecord): GridRecord {
  return { ...grid, pinnedAt: null };
}

export function removeThreadFromGridRecord(grid: GridRecord, threadId: string): GridRecord {
  return withTree(grid, grid.tree === null ? null : removeThread(grid.tree, threadId));
}

/** A thread lives in at most one grid: adding it elsewhere removes it from the grid it was in. */
export function removeThreadFromOtherGrids(
  grids: readonly GridRecord[],
  exceptGridId: string,
  threadId: string,
): GridRecord[] {
  return grids.map((grid) =>
    grid.id === exceptGridId || grid.tree === null || !containsThreadId(grid.tree, threadId)
      ? grid
      : withTree(grid, removeThread(grid.tree, threadId)),
  );
}

export function replaceThreadDraft(
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
    return { ...withTree(grid, withDraft), focusedThreadId: threadId, pendingDraft: null };
  }
  const previousIds = existing.map((leaf) => leaf.threadId);
  const tree = addThreadPreservingLayout(grid.tree, threadId, previousIds);
  const withDraft = draftId === undefined ? tree : replaceThreadDraft(tree, threadId, draftId);
  return { ...withTree(grid, withDraft), focusedThreadId: threadId, pendingDraft: null };
}

export type PlaceThreadRefusal =
  | { readonly reason: "grid_not_found"; readonly gridId: string }
  | {
      readonly reason: "grid_full";
      readonly gridId: string;
      readonly threadCount: number;
      readonly limit: number;
    }
  | {
      readonly reason: "cross_project";
      readonly gridId: string;
      readonly threadProject: ProjectOwner;
      readonly gridProject: ProjectOwner;
    };

export type PlaceThreadResult =
  | { readonly ok: true; readonly grids: GridRecord[] }
  | ({ readonly ok: false } & PlaceThreadRefusal);

/** Appends a thread to a grid, removing it from any other; a thread already shown is only focused. */
export function placeThread(
  grids: readonly GridRecord[],
  input: { gridId: string; threadId: string; draftId?: string },
): PlaceThreadResult {
  const target = gridById(grids, input.gridId);
  if (target === null) return { ok: false, reason: "grid_not_found", gridId: input.gridId };
  const threadCount = gridThreadCount(target);
  if (!containsThreadId(target.tree, input.threadId) && threadCount >= MAX_GRID_THREADS) {
    return {
      ok: false,
      reason: "grid_full",
      gridId: input.gridId,
      threadCount,
      limit: MAX_GRID_THREADS,
    };
  }
  return {
    ok: true,
    grids: updateGrid(
      removeThreadFromOtherGrids(grids, input.gridId, input.threadId),
      input.gridId,
      (grid) => addThreadToGrid(grid, input.threadId, input.draftId),
    ),
  };
}

/** Appends a thread to another grid of its own project; a thread never leaves its project. */
export function moveThreadToGridRecords(
  grids: readonly GridRecord[],
  input: {
    threadId: string;
    threadEnvironmentId: string;
    threadProjectId: string;
    targetGridId: string;
  },
): PlaceThreadResult {
  const target = gridById(grids, input.targetGridId);
  if (target === null) return { ok: false, reason: "grid_not_found", gridId: input.targetGridId };
  const threadProject = {
    environmentId: input.threadEnvironmentId,
    projectId: input.threadProjectId,
  };
  if (!sameProject(threadProject, target)) {
    return {
      ok: false,
      reason: "cross_project",
      gridId: target.id,
      threadProject,
      gridProject: { environmentId: target.environmentId, projectId: target.projectId },
    };
  }
  return placeThread(grids, { gridId: input.targetGridId, threadId: input.threadId });
}

function parsePendingDraft(value: unknown): { draftId: string; threadId: string } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<{ draftId: string; threadId: string }>;
  if (typeof raw.draftId !== "string" || raw.draftId.length === 0) return null;
  if (typeof raw.threadId !== "string" || raw.threadId.length === 0) return null;
  return { draftId: raw.draftId, threadId: raw.threadId };
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
  const pendingDraft = parsePendingDraft(raw.pendingDraft);
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
    ...(pendingDraft === null ? {} : { pendingDraft }),
    ...(raw.detailsOpen === true ? { detailsOpen: true as const } : {}),
    ...(typeof raw.panelPinnedThreadId === "string" &&
    containsThreadId(tree, raw.panelPinnedThreadId)
      ? { panelPinnedThreadId: raw.panelPinnedThreadId }
      : {}),
    pinnedAt: typeof raw.pinnedAt === "string" ? raw.pinnedAt : null,
    hidden: raw.hidden === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
  };
}

/** Keeps the entries that parse and the first of each id; anything else is dropped. */
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
