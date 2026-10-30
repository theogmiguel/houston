/**
 * Ported from Houston v1's renderer split tree (ui/src/renderer/src/layout/tree.ts)
 * and reduced to thread leaves, which is all a v2 grid holds. A grid's tree lives in
 * the renderer only; it never reaches the server or the wire protocol.
 */

export interface ThreadNode {
  kind: "thread";
  threadId: string;
  id: string;
  /** A cell can show a client-side draft before its first turn is sent. */
  draftId?: string;
}

export interface SplitNode {
  kind: "split";
  dir: "row" | "col";
  children: LayoutNode[];
  weights: number[];
}

export type LayoutNode = ThreadNode | SplitNode;

export type PaneKey = string;

export type Side = "left" | "right" | "top" | "bottom" | "center";
export type SplitSide = Exclude<Side, "center">;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PaneRect {
  node: ThreadNode;
  rect: Rect;
}
export interface SplitterRect {
  path: number[];
  index: number;
  dir: "row" | "col";
  rect: Rect;
  startPct: number;
  spanPct: number;
}

// Absolute CSS-pixel floor, not a share of the container: what makes a cell
// unusable is how little of a timeline fits, and that is pixels.
export const MIN_PANE_PX = 240;

export function clampSplitRatio(ratio: number, spanPx: number): number {
  if (spanPx <= 0) return 0.5;
  const minLocal = Math.min(0.5, MIN_PANE_PX / spanPx);
  return Math.max(minLocal, Math.min(1 - minLocal, ratio));
}

let paneSeq = 0;
export function newPaneId(): string {
  return `p${Date.now()}-${++paneSeq}`;
}

export function threadLeaf(
  threadId: string,
  id: string = newPaneId(),
  draftId?: string,
): ThreadNode {
  return draftId === undefined
    ? { kind: "thread", threadId, id }
    : { kind: "thread", threadId, id, draftId };
}

export function paneKey(node: ThreadNode): PaneKey {
  return node.threadId;
}

export function paneId(node: ThreadNode): string {
  return node.id;
}

function evenWeights(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n);
}

function normalize(weights: number[]): number[] {
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) return evenWeights(weights.length);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / total) * 100);
}

export function preorderLeaves(node: LayoutNode | null): PaneKey[] {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap(preorderLeaves);
  return [node.threadId];
}

export function preorderThreads(node: LayoutNode | null): ThreadNode[] {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap(preorderThreads);
  return [node];
}

function filterTree(node: LayoutNode, keep: (pane: ThreadNode) => boolean): LayoutNode | null {
  if (node.kind !== "split") return keep(node) ? node : null;
  const kept: { node: LayoutNode; weight: number }[] = [];
  node.children.forEach((child, i) => {
    const p = filterTree(child, keep);
    if (p) kept.push({ node: p, weight: node.weights[i] ?? 1 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.node;
  return {
    kind: "split",
    dir: node.dir,
    children: kept.map((k) => k.node),
    weights: normalize(kept.map((k) => k.weight)),
  };
}

export function prune(node: LayoutNode, alive: Set<string>): LayoutNode | null {
  return filterTree(node, (p) => alive.has(p.threadId));
}

export function removeThread(tree: LayoutNode, threadId: PaneKey): LayoutNode | null {
  return filterTree(tree, (p) => p.threadId !== threadId);
}

export function containsThread(tree: LayoutNode | null, threadId: PaneKey): boolean {
  return findThread(tree, threadId) !== null;
}

export function findThread(node: LayoutNode | null, threadId: PaneKey): ThreadNode | null {
  if (!node) return null;
  if (node.kind !== "split") return node.threadId === threadId ? node : null;
  for (const child of node.children) {
    const found = findThread(child, threadId);
    if (found) return found;
  }
  return null;
}

export function appendToRoot(tree: LayoutNode | null, node: ThreadNode): LayoutNode {
  if (!tree) return node;
  if (tree.kind !== "split") {
    return { kind: "split", dir: "row", children: [tree, node], weights: [50, 50] };
  }
  const n = tree.children.length + 1;
  const scaled = normalize(tree.weights).map((w) => w * ((n - 1) / n));
  return {
    kind: "split",
    dir: tree.dir,
    children: [...tree.children, node],
    weights: [...scaled, 100 / n],
  };
}

export function appendThread(tree: LayoutNode | null, threadId: string): LayoutNode {
  return appendToRoot(tree, threadLeaf(threadId));
}

function insertChildAt(split: SplitNode, index: number, node: ThreadNode): SplitNode {
  const count = split.children.length + 1;
  const scaled = normalize(split.weights).map((weight) => weight * ((count - 1) / count));
  const children = [...split.children];
  children.splice(index, 0, node);
  const weights = [...scaled];
  weights.splice(index, 0, 100 / count);
  return { ...split, children, weights };
}

/**
 * Inserts a thread at a preorder slot, so a thread that left a grid returns to
 * the pane it left. Slots past the end append.
 */
export function insertThreadAtSlot(
  tree: LayoutNode | null,
  node: ThreadNode,
  slot: number,
): LayoutNode {
  if (tree === null) return node;
  const position = Number.isFinite(slot) ? Math.max(0, Math.trunc(slot)) : 0;
  if (tree.kind !== "split") {
    return position <= 0
      ? { kind: "split", dir: "row", children: [node, tree], weights: [50, 50] }
      : { kind: "split", dir: "row", children: [tree, node], weights: [50, 50] };
  }
  let start = 0;
  for (let index = 0; index < tree.children.length; index += 1) {
    const child = tree.children[index]!;
    const count = preorderThreads(child).length;
    if (position === start) return insertChildAt(tree, index, node);
    if (position < start + count) {
      return {
        ...tree,
        children: tree.children.map((entry, entryIndex) =>
          entryIndex === index ? insertThreadAtSlot(child, node, position - start) : entry,
        ),
      };
    }
    start += count;
  }
  return insertChildAt(tree, tree.children.length, node);
}

export function insertThreadAt(
  tree: LayoutNode | null,
  threadId: string,
  anchor: PaneKey | null,
): LayoutNode {
  if (tree === null) return threadLeaf(threadId);
  if (anchor !== null && findThread(tree, anchor)) {
    return insertBeside(tree, anchor, threadLeaf(threadId), "right");
  }
  return appendThread(tree, threadId);
}

function rowOf(ids: readonly string[], weights?: number[]): LayoutNode {
  if (ids.length === 1) return threadLeaf(ids[0]!);
  return {
    kind: "split",
    dir: "row",
    children: ids.map((id) => threadLeaf(id)),
    weights: weights ?? evenWeights(ids.length),
  };
}

function columnOf(children: LayoutNode[], weights?: number[]): LayoutNode {
  return {
    kind: "split",
    dir: "col",
    children,
    weights: weights ?? evenWeights(children.length),
  };
}

/**
 * The automatic arrangement for a grid of one to six threads. The first thread
 * keeps the leading, tallest slot because it is usually the one that started the
 * work; a seventh thread gets a new grid instead of a pane below the 240px floor.
 */
export function gridPreset(ids: readonly string[]): LayoutNode | null {
  const [first, second, third, fourth, fifth, sixth] = ids;
  switch (ids.length) {
    case 0:
      return null;
    case 1:
      return threadLeaf(first!);
    case 2:
      return rowOf([first!, second!]);
    case 3:
      return {
        kind: "split",
        dir: "row",
        children: [threadLeaf(first!), columnOf([threadLeaf(second!), threadLeaf(third!)])],
        weights: [100 * (1.25 / 2.25), 100 * (1 / 2.25)],
      };
    case 4:
      return columnOf([rowOf([first!, second!]), rowOf([third!, fourth!])]);
    case 5:
      return {
        kind: "split",
        dir: "row",
        children: [
          threadLeaf(first!),
          columnOf([rowOf([second!, third!]), rowOf([fourth!, fifth!])]),
        ],
        weights: [100 * (1.2 / 3.2), 100 * (2 / 3.2)],
      };
    case 6:
      return columnOf([rowOf([first!, second!, third!]), rowOf([fourth!, fifth!, sixth!])]);
    default:
      return evenGrid(ids);
  }
}

/**
 * An even chunked grid for more threads than a preset holds. Kept as the
 * fallback for callers that build grids outside the six-thread limit.
 */
export function evenGrid(ids: readonly string[]): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return threadLeaf(ids[0]!);
  const perRow = ids.length <= 4 ? 2 : 3;
  const rows: string[][] = [];
  for (let i = 0; i < ids.length; i += perRow) rows.push(ids.slice(i, i + perRow));
  if (rows.length === 1) return rowOf(rows[0]!);
  return columnOf(rows.map((row) => rowOf(row)));
}

function treeShape(node: LayoutNode | null): string {
  if (node === null) return "empty";
  if (node.kind === "thread") return `t(${node.threadId})`;
  const weights = node.weights.map((weight) => weight.toFixed(2)).join(",");
  return `${node.dir}(${node.children.map(treeShape).join("|")};${weights})`;
}

/** True when the tree is still the automatic arrangement for these threads. */
export function isGridPreset(tree: LayoutNode | null, ids: readonly string[]): boolean {
  const expected = gridPreset(ids);
  return expected !== null && treeShape(tree) === treeShape(expected);
}

export function tidyColumns(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt((n * 16) / 9))));
}

export type TidyShape = "grid" | "row" | "column";

export function tidy(tree: LayoutNode | null, shape: TidyShape = "grid"): LayoutNode | null {
  if (!tree) return null;
  const leaves = preorderThreads(tree);
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]!;
  const cols =
    shape === "row" ? leaves.length : shape === "column" ? 1 : tidyColumns(leaves.length);
  const rows: ThreadNode[][] = [];
  for (let i = 0; i < leaves.length; i += cols) rows.push(leaves.slice(i, i + cols));
  const rowNode = (row: ThreadNode[]): LayoutNode =>
    row.length === 1
      ? row[0]!
      : {
          kind: "split",
          dir: "row",
          children: row,
          weights: evenWeights(row.length),
        };
  if (rows.length === 1) return rowNode(rows[0]!);
  return {
    kind: "split",
    dir: "col",
    children: rows.map(rowNode),
    weights: evenWeights(rows.length),
  };
}

/**
 * Reading-order arrangement for the Grid layout menu. It reuses the same
 * preset shapes that fill an untouched grid, so there is one arrangement rule.
 */
export function arrangeThreads(tree: LayoutNode | null): LayoutNode | null {
  return gridPreset(preorderThreads(tree).map((leaf) => leaf.threadId));
}

export function equalize(tree: LayoutNode): LayoutNode {
  if (tree.kind !== "split") return tree;
  return {
    ...tree,
    children: tree.children.map(equalize),
    weights: evenWeights(tree.children.length),
  };
}

export function adjacentThreadKey(
  tree: LayoutNode | null,
  key: PaneKey,
  offset: number,
): PaneKey | null {
  const keys = preorderLeaves(tree);
  if (keys.length < 2) return null;
  const i = keys.indexOf(key);
  if (i < 0) return null;
  return keys[(((i + offset) % keys.length) + keys.length) % keys.length]!;
}

export function reconcileThreads(tree: LayoutNode | null, threadIds: string[]): LayoutNode | null {
  const previousIds = tree === null ? [] : preorderThreads(tree).map((leaf) => leaf.threadId);
  const auto = tree !== null && isGridPreset(tree, previousIds);
  const alive = new Set(threadIds);
  const next = tree ? prune(tree, alive) : null;
  if (!next || auto) return gridPreset(threadIds);
  const present = new Set(preorderLeaves(next));
  let appended = next;
  for (const threadId of threadIds) {
    if (!present.has(threadId)) appended = appendThread(appended, threadId);
  }
  return appended;
}

export function insertBeside(
  tree: LayoutNode,
  target: PaneKey,
  node: ThreadNode,
  side: SplitSide,
): LayoutNode {
  const dir: "row" | "col" = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind !== "split") {
      if (n.threadId !== target) return n;
      const children = before ? [node, n] : [n, node];
      return { kind: "split", dir, children, weights: [50, 50] };
    }
    return { ...n, children: n.children.map(rec) };
  };
  return rec(tree);
}

export function moveThread(
  tree: LayoutNode,
  dragged: PaneKey,
  target: PaneKey,
  side: SplitSide,
): LayoutNode {
  if (dragged === target) return tree;
  const node = findThread(tree, dragged);
  if (!node || !findThread(tree, target)) return tree;
  const removed = removeThread(tree, dragged);
  if (!removed || !findThread(removed, target)) return tree;
  return insertBeside(removed, target, node, side);
}

export function swapThread(tree: LayoutNode | null, a: PaneKey, b: PaneKey): LayoutNode | null {
  if (!tree || a === b) return tree;
  const nodeA = findThread(tree, a);
  const nodeB = findThread(tree, b);
  if (!nodeA || !nodeB) return tree;
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind !== "split") {
      if (n.threadId === a) return nodeB;
      if (n.threadId === b) return nodeA;
      return n;
    }
    return { ...n, children: n.children.map(rec) };
  };
  return rec(tree);
}

export function setRatio(
  tree: LayoutNode,
  path: number[],
  index: number,
  ratio: number,
): LayoutNode {
  const rec = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.kind !== "split") return node;
    if (depth === path.length) {
      if (!Number.isFinite(ratio) || index < 0 || index + 1 >= node.weights.length) return node;
      const weights = [...node.weights];
      const sum = weights[index]! + weights[index + 1]!;
      weights[index] = ratio * sum;
      weights[index + 1] = sum - weights[index]!;
      return { ...node, weights };
    }
    const ci = path[depth];
    if (ci === undefined || ci < 0 || ci >= node.children.length) return node;
    return {
      ...node,
      children: node.children.map((c, i) => (i === ci ? rec(c, depth + 1) : c)),
    };
  };
  return rec(tree, 0);
}

export function computeRects(tree: LayoutNode): {
  leaves: PaneRect[];
  splitters: SplitterRect[];
} {
  const leaves: PaneRect[] = [];
  const splitters: SplitterRect[] = [];
  const walk = (node: LayoutNode, rect: Rect, path: number[]): void => {
    if (node.kind !== "split") {
      leaves.push({ node, rect });
      return;
    }
    const horizontal = node.dir === "row";
    const total = node.weights.reduce((a, b) => a + b, 0) || node.children.length;
    const span = horizontal ? rect.w : rect.h;
    let off = horizontal ? rect.x : rect.y;
    node.children.forEach((child, i) => {
      const size = span * ((node.weights[i] ?? 1) / total);
      const childRect: Rect = horizontal
        ? { x: off, y: rect.y, w: size, h: rect.h }
        : { x: rect.x, y: off, w: rect.w, h: size };
      walk(child, childRect, [...path, i]);
      off += size;
      if (i < node.children.length - 1) {
        const nextSize = span * ((node.weights[i + 1] ?? 1) / total);
        splitters.push({
          path,
          index: i,
          dir: node.dir,
          rect: horizontal
            ? { x: off, y: rect.y, w: 0, h: rect.h }
            : { x: rect.x, y: off, w: rect.w, h: 0 },
          startPct: off - size,
          spanPct: size + nextSize,
        });
      }
    });
  };
  walk(tree, { x: 0, y: 0, w: 100, h: 100 }, []);
  return { leaves, splitters };
}

export function quadrant(rect: DOMRect, x: number, y: number): Side {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  if (rx >= 0.25 && rx <= 0.75 && ry >= 0.25 && ry <= 0.75) return "center";
  const dist: Record<SplitSide, number> = {
    left: rx,
    right: 1 - rx,
    top: ry,
    bottom: 1 - ry,
  };
  return (Object.keys(dist) as SplitSide[]).reduce(
    (best, s) => (dist[s] < dist[best] ? s : best),
    "left",
  );
}

export function isLayoutNode(x: unknown): x is LayoutNode {
  if (!x || typeof x !== "object") return false;
  const n = x as Record<string, unknown>;
  if (n.kind === "thread") {
    return (
      typeof n.threadId === "string" &&
      n.threadId.length > 0 &&
      typeof n.id === "string" &&
      n.id.length > 0 &&
      (n.draftId === undefined || typeof n.draftId === "string")
    );
  }
  if (n.kind !== "split") return false;
  return (
    (n.dir === "row" || n.dir === "col") &&
    Array.isArray(n.children) &&
    Array.isArray(n.weights) &&
    n.children.length === n.weights.length &&
    n.children.length > 0 &&
    n.children.every(isLayoutNode) &&
    (n.weights as unknown[]).every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)
  );
}
