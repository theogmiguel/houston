import { STACK_CAP_MAX, stackCapacity } from '../paneCaps'

export interface LeafNode {
  kind: 'leaf'
  session: number
  id: string
}
export interface BrowserNode {
  kind: 'browser'
  id: string
  url: string
}
export interface EditorNode {
  kind: 'editor'
  id: string
  path: string
}
export interface GitNode {
  kind: 'git'
  id: string
}
export interface SkillsNode {
  kind: 'skills'
  id: string
}
export interface FilesNode {
  kind: 'files'
  id: string
  root?: string
}
export interface SplitNode {
  kind: 'split'
  dir: 'row' | 'col'
  children: LayoutNode[]
  weights: number[]
}
export interface StackNode {
  kind: 'stack'
  id: string
  children: PaneNode[]
  activeIndex: number
}
export type LayoutNode =
  | LeafNode
  | BrowserNode
  | EditorNode
  | GitNode
  | SkillsNode
  | FilesNode
  | StackNode
  | SplitNode
export type PaneNode = LeafNode | BrowserNode | EditorNode | GitNode | SkillsNode | FilesNode
export type GridSlot = PaneNode | StackNode

export const MAX_STACK_TABS = 4

export function isLayoutNode(x: unknown): x is LayoutNode {
  return isNode(x)
}

export type PaneKey = number | string

export type Side = 'left' | 'right' | 'top' | 'bottom' | 'center'
export type SplitSide = Exclude<Side, 'center'>

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
export interface PaneRect {
  node: GridSlot
  rect: Rect
}
export interface SplitterRect {
  path: number[]
  index: number
  dir: 'row' | 'col'
  rect: Rect
  startPct: number
  spanPct: number
}

// Absolute CSS-pixel floor, not a share of the container: what makes a pane
// unusable is how few terminal columns fit, and columns are pixels, so one
// percentage cannot mean the same thing on a laptop and an ultrawide.
export const MIN_PANE_PX = 140

export function clampSplitRatio(ratio: number, spanPx: number): number {
  if (spanPx <= 0) return 0.5
  const minLocal = Math.min(0.5, MIN_PANE_PX / spanPx)
  return Math.max(minLocal, Math.min(1 - minLocal, ratio))
}

let paneSeq = 0
export function newPaneId(): string {
  return `p${Date.now()}-${++paneSeq}`
}

export function leaf(session: number, id: string = newPaneId()): LeafNode {
  return { kind: 'leaf', session, id }
}

export function skillsPane(id: string = newPaneId()): SkillsNode {
  return { kind: 'skills', id }
}

export function filesPane(root?: string, id: string = newPaneId()): FilesNode {
  return root === undefined ? { kind: 'files', id } : { kind: 'files', id, root }
}
export function stackPane(
  children: PaneNode[],
  activeIndex = 0,
  id: string = newPaneId()
): StackNode {
  return { kind: 'stack', id, children, activeIndex }
}

export function paneKey(node: GridSlot): PaneKey {
  return node.kind === 'leaf' ? node.session : node.id
}

export function paneId(node: GridSlot): string {
  return node.id
}

function evenWeights(n: number): number[] {
  return Array.from({ length: n }, () => 100 / n)
}

function normalize(weights: number[]): number[] {
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) return evenWeights(weights.length)
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map((w) => (w / total) * 100)
}

export function preorderLeaves(node: LayoutNode | null): PaneKey[] {
  if (!node) return []
  if (node.kind === 'split' || node.kind === 'stack') return node.children.flatMap(preorderLeaves)
  return [paneKey(node)]
}

export function preorderSessions(node: LayoutNode | null): number[] {
  return preorderLeaves(node).filter((k): k is number => typeof k === 'number')
}

function filterTree(node: LayoutNode, keep: (pane: PaneNode) => boolean): LayoutNode | null {
  if (node.kind === 'stack') {
    const kept = node.children.filter(keep)
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0]
    const activeKey = paneKey(node.children[node.activeIndex] ?? node.children[0])
    const activeIndex = Math.max(
      0,
      kept.findIndex((p) => paneKey(p) === activeKey)
    )
    return { ...node, children: kept, activeIndex }
  }
  if (node.kind !== 'split') return keep(node) ? node : null
  const kept: { node: LayoutNode; weight: number }[] = []
  node.children.forEach((child, i) => {
    const p = filterTree(child, keep)
    if (p) kept.push({ node: p, weight: node.weights[i] ?? 1 })
  })
  if (kept.length === 0) return null
  if (kept.length === 1) return kept[0].node
  return {
    kind: 'split',
    dir: node.dir,
    children: kept.map((k) => k.node),
    weights: normalize(kept.map((k) => k.weight))
  }
}

export function prune(node: LayoutNode, alive: Set<number>): LayoutNode | null {
  return filterTree(node, (p) => p.kind !== 'leaf' || alive.has(p.session))
}

export function removeLeaf(tree: LayoutNode, key: PaneKey): LayoutNode | null {
  return filterTree(tree, (p) => paneKey(p) !== key)
}

export function containsPaneKind(tree: LayoutNode | null, kind: PaneNode['kind']): boolean {
  if (!tree) return false
  if (tree.kind === 'split' || tree.kind === 'stack')
    return tree.children.some((c) => containsPaneKind(c, kind))
  return tree.kind === kind
}

// Filtering through `filterTree` is what keeps this safe: a split whose only
// other child left collapses to that child, a stack keeps its remaining tabs,
// and every surviving weight is renormalized — never a dropped terminal.
export function removePaneKind(tree: LayoutNode, kind: PaneNode['kind']): LayoutNode | null {
  return filterTree(tree, (p) => p.kind !== kind)
}

export function sessionForPaneId(node: LayoutNode | null, id: string): number | null {
  if (!node) return null
  if (node.kind === 'split' || node.kind === 'stack') {
    for (const child of node.children) {
      const found = sessionForPaneId(child, id)
      if (found !== null) return found
    }
    return null
  }
  return node.kind === 'leaf' && node.id === id ? node.session : null
}

export function findPane(node: LayoutNode, key: PaneKey): PaneNode | null {
  if (node.kind === 'stack') {
    for (const child of node.children) {
      if (paneKey(child) === key) return child
    }
    return null
  }
  if (node.kind !== 'split') {
    return paneKey(node) === key ? node : null
  }
  for (const child of node.children) {
    const found = findPane(child, key)
    if (found) return found
  }
  return null
}

export function findStackContaining(node: LayoutNode, key: PaneKey): StackNode | null {
  if (node.kind === 'stack') {
    return node.children.some((c) => paneKey(c) === key) ? node : null
  }
  if (node.kind !== 'split') return null
  for (const child of node.children) {
    const found = findStackContaining(child, key)
    if (found) return found
  }
  return null
}

export function findEditorByPath(node: LayoutNode, path: string): EditorNode | null {
  if (node.kind === 'editor') return node.path === path ? node : null
  if (node.kind !== 'split' && node.kind !== 'stack') return null
  for (const child of node.children) {
    const found = findEditorByPath(child, path)
    if (found) return found
  }
  return null
}

export function appendToRoot(tree: LayoutNode | null, node: PaneNode): LayoutNode {
  if (!tree) return node
  if (tree.kind !== 'split') {
    return { kind: 'split', dir: 'row', children: [tree, node], weights: [50, 50] }
  }
  const n = tree.children.length + 1
  const scaled = normalize(tree.weights).map((w) => w * ((n - 1) / n))
  return {
    kind: 'split',
    dir: tree.dir,
    children: [...tree.children, node],
    weights: [...scaled, 100 / n]
  }
}

export function insertPaneAt(
  tree: LayoutNode | null,
  node: PaneNode,
  anchor: PaneKey | null
): LayoutNode {
  if (tree === null) return node
  if (anchor !== null && findPane(tree, anchor)) return insertBeside(tree, anchor, node, 'right')
  return appendToRoot(tree, node)
}

export function evenGrid(ids: number[], cols: number): LayoutNode | null {
  if (ids.length === 0) return null
  if (ids.length === 1) return leaf(ids[0])
  const perRow = Math.max(1, Math.min(cols, ids.length))
  const rows: number[][] = []
  for (let i = 0; i < ids.length; i += perRow) rows.push(ids.slice(i, i + perRow))
  const rowNode = (row: number[]): LayoutNode =>
    row.length === 1
      ? leaf(row[0])
      : { kind: 'split', dir: 'row', children: row.map((s) => leaf(s)), weights: evenWeights(row.length) }
  if (rows.length === 1) return rowNode(rows[0])
  return {
    kind: 'split',
    dir: 'col',
    children: rows.map(rowNode),
    weights: evenWeights(rows.length)
  }
}

export function preorderNonSessionPanes(node: LayoutNode | null): PaneNode[] {
  if (!node) return []
  if (node.kind === 'split' || node.kind === 'stack')
    return node.children.flatMap(preorderNonSessionPanes)
  return node.kind === 'leaf' ? [] : [node]
}

export function regrid(tree: LayoutNode | null, ids: number[], cols: number): LayoutNode | null {
  const kept = preorderNonSessionPanes(tree)
  let next = adoptPaneIds(evenGrid(ids, cols), sessionPaneIds(tree))
  for (const pane of kept) next = next === null ? pane : appendToRoot(next, pane)
  return next
}

export function preorderSlots(node: LayoutNode | null): GridSlot[] {
  if (!node) return []
  if (node.kind === 'split') return node.children.flatMap(preorderSlots)
  return [node]
}

export function tidyColumns(n: number): number {
  if (n <= 1) return 1
  if (n <= 4) return 2
  if (n <= 6) return 3
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt((n * 16) / 9))))
}

export function tidy(tree: LayoutNode | null): LayoutNode | null {
  if (!tree) return null
  const slots = preorderSlots(tree)
  if (slots.length === 0) return null
  if (slots.length === 1) return slots[0]
  const cols = tidyColumns(slots.length)
  const rows: GridSlot[][] = []
  for (let i = 0; i < slots.length; i += cols) rows.push(slots.slice(i, i + cols))
  const rowNode = (row: GridSlot[]): LayoutNode =>
    row.length === 1
      ? row[0]
      : { kind: 'split', dir: 'row', children: row, weights: evenWeights(row.length) }
  if (rows.length === 1) return rowNode(rows[0])
  return {
    kind: 'split',
    dir: 'col',
    children: rows.map(rowNode),
    weights: evenWeights(rows.length)
  }
}

export function equalize(tree: LayoutNode): LayoutNode {
  if (tree.kind !== 'split') return tree
  return {
    ...tree,
    children: tree.children.map(equalize),
    weights: evenWeights(tree.children.length)
  }
}

export function adjacentPaneKey(
  tree: LayoutNode | null,
  key: PaneKey,
  offset: number
): PaneKey | null {
  const keys = preorderLeaves(tree)
  if (keys.length < 2) return null
  const i = keys.indexOf(key)
  if (i < 0) return null
  return keys[(((i + offset) % keys.length) + keys.length) % keys.length]
}

export function sessionPaneIds(tree: LayoutNode | null): Map<number, string> {
  const map = new Map<number, string>()
  const walk = (n: LayoutNode): void => {
    if (n.kind === 'split' || n.kind === 'stack') n.children.forEach(walk)
    else if (n.kind === 'leaf') map.set(n.session, n.id)
  }
  if (tree) walk(tree)
  return map
}

function adoptPaneIds(node: LayoutNode | null, ids: Map<number, string>): LayoutNode | null {
  if (!node) return null
  if (node.kind === 'split') {
    return { ...node, children: node.children.map((c) => adoptPaneIds(c, ids) as LayoutNode) }
  }
  if (node.kind !== 'leaf') return node
  const known = ids.get(node.session)
  return known === undefined ? node : { ...node, id: known }
}

export function reviveLeaf(
  tree: LayoutNode | null,
  pane: string,
  session: number
): LayoutNode | null {
  if (!tree) return null
  let hit = false
  const walkPane = (n: PaneNode): PaneNode => {
    if (n.kind === 'leaf' && n.id === pane) {
      hit = true
      return { ...n, session }
    }
    return n
  }
  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'split') return { ...n, children: n.children.map(walk) }
    if (n.kind === 'stack') return { ...n, children: n.children.map(walkPane) }
    return walkPane(n)
  }
  const next = walk(tree)
  return hit ? next : null
}

export function syncTree(
  tree: LayoutNode | null,
  aliveIds: number[],
  cols: number
): LayoutNode | null {
  const alive = new Set(aliveIds)
  let next = tree ? prune(tree, alive) : null
  if (!next) return regrid(tree, aliveIds, cols)
  const present = new Set(preorderSessions(next))
  for (const id of aliveIds) if (!present.has(id)) next = appendToRoot(next, leaf(id))
  return next
}

export function insertBeside(
  tree: LayoutNode,
  target: PaneKey,
  node: PaneNode,
  side: SplitSide
): LayoutNode {
  const dir: 'row' | 'col' = side === 'left' || side === 'right' ? 'row' : 'col'
  const before = side === 'left' || side === 'top'
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind !== 'split') {
      if (paneKey(n) !== target) return n
      const children = before ? [node, n] : [n, node]
      return { kind: 'split', dir, children, weights: [50, 50] }
    }
    return { ...n, children: n.children.map(rec) }
  }
  return rec(tree)
}

export function moveLeaf(
  tree: LayoutNode,
  dragged: PaneKey,
  target: PaneKey,
  side: SplitSide
): LayoutNode {
  if (dragged === target) return tree
  const node = findPane(tree, dragged)
  if (!node || !findPane(tree, target)) return tree
  const removed = removeLeaf(tree, dragged)
  if (!removed || !findPane(removed, target)) return tree
  return insertBeside(removed, target, node, side)
}

export function swapLeaf(tree: LayoutNode | null, a: PaneKey, b: PaneKey): LayoutNode | null {
  if (!tree || a === b) return tree
  const nodeA = findPane(tree, a)
  const nodeB = findPane(tree, b)
  if (!nodeA || !nodeB) return tree
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'stack') return { ...n, children: n.children.map((c) => rec(c) as PaneNode) }
    if (n.kind !== 'split') {
      const key = paneKey(n)
      if (key === a) return nodeB
      if (key === b) return nodeA
      return n
    }
    return { ...n, children: n.children.map(rec) }
  }
  return rec(tree)
}

export function updateBrowserUrl(tree: LayoutNode, id: string, url: string): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'browser') return n.id === id ? { ...n, url } : n
    if (n.kind === 'stack') return { ...n, children: n.children.map((c) => rec(c) as PaneNode) }
    if (n.kind !== 'split') return n
    return { ...n, children: n.children.map(rec) }
  }
  return rec(tree)
}

export function setRatio(
  tree: LayoutNode,
  path: number[],
  index: number,
  ratio: number
): LayoutNode {
  const rec = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.kind !== 'split') return node
    if (depth === path.length) {
      if (!Number.isFinite(ratio) || index < 0 || index + 1 >= node.weights.length) return node
      const weights = [...node.weights]
      const sum = weights[index] + weights[index + 1]
      weights[index] = ratio * sum
      weights[index + 1] = sum - weights[index]
      return { ...node, weights }
    }
    const ci = path[depth]
    if (ci === undefined || ci < 0 || ci >= node.children.length) return node
    return {
      ...node,
      children: node.children.map((c, i) => (i === ci ? rec(c, depth + 1) : c))
    }
  }
  return rec(tree, 0)
}

export function computeRects(tree: LayoutNode): {
  leaves: PaneRect[]
  splitters: SplitterRect[]
} {
  const leaves: PaneRect[] = []
  const splitters: SplitterRect[] = []
  const walk = (node: LayoutNode, rect: Rect, path: number[]): void => {
    if (node.kind !== 'split') {
      leaves.push({ node, rect })
      return
    }
    const horizontal = node.dir === 'row'
    const total = node.weights.reduce((a, b) => a + b, 0) || node.children.length
    const span = horizontal ? rect.w : rect.h
    let off = horizontal ? rect.x : rect.y
    node.children.forEach((child, i) => {
      const size = span * ((node.weights[i] ?? 1) / total)
      const childRect: Rect = horizontal
        ? { x: off, y: rect.y, w: size, h: rect.h }
        : { x: rect.x, y: off, w: rect.w, h: size }
      walk(child, childRect, [...path, i])
      off += size
      if (i < node.children.length - 1) {
        const nextSize = span * ((node.weights[i + 1] ?? 1) / total)
        splitters.push({
          path,
          index: i,
          dir: node.dir,
          rect: horizontal
            ? { x: off, y: rect.y, w: 0, h: rect.h }
            : { x: rect.x, y: off, w: rect.w, h: 0 },
          startPct: off - size,
          spanPct: size + nextSize
        })
      }
    })
  }
  walk(tree, { x: 0, y: 0, w: 100, h: 100 }, [])
  return { leaves, splitters }
}

export function quadrant(rect: DOMRect, x: number, y: number): Side {
  const rx = (x - rect.left) / rect.width
  const ry = (y - rect.top) / rect.height
  if (rx >= 0.25 && rx <= 0.75 && ry >= 0.25 && ry <= 0.75) return 'center'
  const dist: Record<SplitSide, number> = {
    left: rx,
    right: 1 - rx,
    top: ry,
    bottom: 1 - ry
  }
  return (Object.keys(dist) as SplitSide[]).reduce(
    (best, s) => (dist[s] < dist[best] ? s : best),
    'left'
  )
}

export interface LayoutState {
  tree: LayoutNode | null
  cols: number
}

function isNode(x: unknown): x is LayoutNode {
  if (!x || typeof x !== 'object') return false
  const n = x as Record<string, unknown>
  if (n.kind === 'leaf') return typeof n.session === 'number'
  if (n.kind === 'browser') return typeof n.id === 'string' && typeof n.url === 'string'
  if (n.kind === 'editor') return typeof n.id === 'string' && typeof n.path === 'string'
  if (n.kind === 'git' || n.kind === 'skills') return typeof n.id === 'string'
  if (n.kind === 'files')
    return typeof n.id === 'string' && (n.root === undefined || typeof n.root === 'string')
  if (n.kind === 'stack') {
    return (
      typeof n.id === 'string' &&
      Array.isArray(n.children) &&
      n.children.length > 0 &&
      n.children.length <= STACK_CAP_MAX &&
      n.children.every((c) => isNode(c) && c.kind !== 'split' && c.kind !== 'stack') &&
      Number.isInteger(n.activeIndex) &&
      (n.activeIndex as number) >= 0 &&
      (n.activeIndex as number) < n.children.length
    )
  }
  if (n.kind === 'split') {
    return (
      (n.dir === 'row' || n.dir === 'col') &&
      Array.isArray(n.children) &&
      Array.isArray(n.weights) &&
      n.children.length === n.weights.length &&
      n.children.length > 0 &&
      n.children.every(isNode) &&
      (n.weights as unknown[]).every((w) => typeof w === 'number' && Number.isFinite(w) && w > 0)
    )
  }
  return false
}

function withPaneIds(node: LayoutNode): LayoutNode {
  if (node.kind === 'split') return { ...node, children: node.children.map(withPaneIds) }
  if (node.kind === 'stack') {
    return { ...node, children: node.children.map((c) => withPaneIds(c) as PaneNode) }
  }
  if (node.kind !== 'leaf') return node
  return typeof node.id === 'string' && node.id.length > 0 ? node : { ...node, id: newPaneId() }
}

const KEY_PREFIX = 'tr-layout:'

export function loadLayout(workspaceKey: string): LayoutState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_PREFIX + workspaceKey) ?? 'null')
    if (raw && typeof raw === 'object') {
      const parsed = raw.tree && isNode(raw.tree) ? withPaneIds(raw.tree as LayoutNode) : null
      // A legacy Changes leaf never reaches the grid: the panel owns it now.
      const tree = parsed && containsPaneKind(parsed, 'git') ? removePaneKind(parsed, 'git') : parsed
      const cols =
        Number.isInteger(raw.cols) && raw.cols >= 1 && raw.cols <= 4 ? (raw.cols as number) : 2
      return { tree, cols }
    }
  } catch {
  }
  return { tree: null, cols: 2 }
}

export function saveLayout(workspaceKey: string, state: LayoutState): void {
  localStorage.setItem(KEY_PREFIX + workspaceKey, JSON.stringify(state))
}

// Writes back every saved grid without its legacy `git` leaf, and reports the
// workspaces that had one so the caller reopens the panel where the pane was.
// Idempotent: a second run finds no leaf and reports nothing.
export function migrateSavedGitLeaves(): string[] {
  const migrated: string[] = []
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      let parsed: Record<string, unknown> | null = null
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
        if (value && typeof value === 'object' && !Array.isArray(value))
          parsed = value as Record<string, unknown>
      } catch {
        continue
      }
      if (!parsed || !isNode(parsed.tree) || !containsPaneKind(parsed.tree, 'git')) continue
      const tree = removePaneKind(parsed.tree, 'git')
      localStorage.setItem(key, JSON.stringify({ ...parsed, tree }))
      const workspace = key.slice(KEY_PREFIX.length).split('::')[0] || 'all'
      if (!migrated.includes(workspace)) migrated.push(workspace)
    }
  } catch {
  }
  return migrated
}

export interface GridMeta {
  id: string
  name: string
  named?: boolean
}

export function isAutoNameable(g: GridMeta): boolean {
  if (g.named !== undefined) return !g.named
  return /^Grid \d+$/.test(g.name)
}

export const DEFAULT_GRID_ID = 'g-default'
const DEFAULT_GRID_NAME = 'Grid 1'

let gridSeq = 0
function newGridId(): string {
  return `g${Date.now()}-${++gridSeq}`
}

function gridsKey(path: string): string {
  return 'tr-grids:' + path
}

export function gridStorageKey(path: string, gridId: string): string {
  return `${path}::${gridId}`
}

function isGridMeta(x: unknown): x is GridMeta {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as Record<string, unknown>).id === 'string' &&
    typeof (x as Record<string, unknown>).name === 'string'
  )
}

function saveGrids(path: string, grids: GridMeta[]): void {
  localStorage.setItem(gridsKey(path), JSON.stringify(grids))
}

function migrateLegacyLayout(path: string): GridMeta[] {
  const legacyRaw = localStorage.getItem(KEY_PREFIX + path)
  if (legacyRaw !== null) {
    localStorage.setItem(KEY_PREFIX + gridStorageKey(path, DEFAULT_GRID_ID), legacyRaw)
  }
  const grids: GridMeta[] = [{ id: DEFAULT_GRID_ID, name: DEFAULT_GRID_NAME }]
  saveGrids(path, grids)
  return grids
}

export function loadGrids(path: string): GridMeta[] {
  try {
    const raw = JSON.parse(localStorage.getItem(gridsKey(path)) ?? 'null')
    if (Array.isArray(raw) && raw.length > 0 && raw.every(isGridMeta)) return raw
  } catch {
  }
  return migrateLegacyLayout(path)
}

export function addGrid(path: string, name: string): GridMeta[] {
  const grids = loadGrids(path)
  const grid: GridMeta = { id: newGridId(), name, named: false }
  const next = [...grids, grid]
  saveGrids(path, next)
  return next
}

export function renameGrid(path: string, gridId: string, name: string): GridMeta[] {
  const next = loadGrids(path).map((g) => (g.id === gridId ? { ...g, name, named: true } : g))
  saveGrids(path, next)
  return next
}

export function autoNameGrid(path: string, gridId: string, name: string): GridMeta[] {
  const next = loadGrids(path).map((g) =>
    g.id === gridId && isAutoNameable(g) ? { ...g, name, named: true } : g
  )
  saveGrids(path, next)
  return next
}

export function removeGrid(path: string, gridId: string): GridMeta[] {
  const grids = loadGrids(path)
  if (grids.length <= 1) return grids
  const next = grids.filter((g) => g.id !== gridId)
  if (next.length === grids.length) return grids
  saveGrids(path, next)
  localStorage.removeItem(KEY_PREFIX + gridStorageKey(path, gridId))
  return next
}

export function syncWorkspaceGrids(
  path: string,
  grids: GridMeta[],
  activeGrid: string,
  wsAliveIds: number[],
  current: Map<string, LayoutState>
): Map<string, LayoutState> {
  const wsAlive = new Set(wsAliveIds)
  const loaded = grids.map((g) => {
    const key = gridStorageKey(path, g.id)
    return { gridId: g.id, key, state: current.get(key) ?? loadLayout(key) }
  })
  const allAssigned = new Set(loaded.flatMap(({ state }) => preorderSessions(state.tree)))
  const next = new Map<string, LayoutState>()
  for (const { gridId, key, state } of loaded) {
    const own = preorderSessions(state.tree)
    const ownSet = new Set(own)
    const ids = own.filter((id) => wsAlive.has(id))
    if (gridId === activeGrid) {
      for (const id of wsAliveIds) if (!ownSet.has(id) && !allAssigned.has(id)) ids.push(id)
    }
    const tree = syncTree(state.tree, ids, state.cols)
    next.set(key, { ...state, tree })
  }
  return next
}

export function stackWith(tree: LayoutNode, a: PaneKey, b: PaneKey): LayoutNode {
  if (a === b) return tree
  const nodeA = findPane(tree, a)
  const nodeB = findPane(tree, b)
  if (!nodeA || !nodeB) return tree
  const container = findStackContaining(tree, a)
  if (container) {
    if (container.children.some((c) => paneKey(c) === b)) return tree
    if (container.children.length >= stackCapacity()) return tree
  }
  const removed = removeLeaf(tree, b)
  if (!removed || !findPane(removed, a)) return tree
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'stack') {
      if (n.id !== container?.id) return n
      return { ...n, children: [...n.children, nodeB] }
    }
    if (n.kind !== 'split') {
      return paneKey(n) === a ? stackPane([n, nodeB]) : n
    }
    return { ...n, children: n.children.map(rec) }
  }
  return rec(removed)
}

export function unstack(tree: LayoutNode, key: PaneKey): LayoutNode {
  const container = findStackContaining(tree, key)
  if (!container) return tree
  const node = findPane(tree, key)
  if (!node) return tree
  const survivor = container.children.find((c) => paneKey(c) !== key)
  const anchor = container.children.length === 2 && survivor ? paneKey(survivor) : container.id
  const removed = removeLeaf(tree, key)
  if (!removed) return tree
  return insertBeside(removed, anchor, node, 'right')
}

export function setActiveStackTab(tree: LayoutNode, stackId: string, key: PaneKey): LayoutNode {
  const rec = (n: LayoutNode): LayoutNode => {
    if (n.kind === 'stack') {
      if (n.id !== stackId) return n
      const idx = n.children.findIndex((c) => paneKey(c) === key)
      return idx === -1 ? n : { ...n, activeIndex: idx }
    }
    if (n.kind !== 'split') return n
    return { ...n, children: n.children.map(rec) }
  }
  return rec(tree)
}
