import type { TransferSessionMapping } from '../houston/generated/TransferSessionMapping'
import {
  gridStorageKey,
  isLayoutNode,
  loadGrids,
  loadLayout,
  newGridId,
  newPaneId,
  type GridMeta,
  type LayoutNode,
  type LayoutState,
  type PaneNode
} from './tree'

// A workspace transfer carries the source workspace's grids as one opaque string: the
// daemon stores it in the file without reading it, and import hands it back here.
interface TransferGrids {
  version: 1
  /** The workspace path the panes were stored under, which can differ from the
   *  canonical path the file records: a symlink, or another spelling on Windows. */
  source?: string
  grids: GridMeta[]
  layouts: Record<string, LayoutState>
}

export function collectTransferGrids(path: string): string {
  const grids = loadGrids(path)
  const layouts: Record<string, LayoutState> = {}
  for (const grid of grids) {
    const { tree, cols } = loadLayout(gridStorageKey(path, grid.id))
    layouts[grid.id] = { tree, cols }
  }
  const blob: TransferGrids = { version: 1, source: path, grids, layouts }
  return JSON.stringify(blob)
}

function parse(blob: string): TransferGrids | null {
  try {
    const raw = JSON.parse(blob) as Partial<TransferGrids>
    if (raw.version !== 1 || !Array.isArray(raw.grids) || !raw.layouts || typeof raw.layouts !== 'object') return null
    return raw as TransferGrids
  } catch {
    return null
  }
}

const isWindowsPath = (path: string): boolean => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')

/** A Windows path with one separator spelling and no verbatim prefix; case is kept. */
function windowsForm(path: string): string {
  const slashes = path.replace(/\//g, '\\')
  const plain = slashes.startsWith('\\\\?\\UNC\\')
    ? `\\\\${slashes.slice(8)}`
    : slashes.startsWith('\\\\?\\')
      ? slashes.slice(4)
      : slashes
  return plain.length > 3 ? plain.replace(/\\+$/, '') : plain
}

function rebaseOne(path: string, source: string, target: string): string | null {
  if (isWindowsPath(source) && isWindowsPath(path)) {
    // Windows compares paths without regard to letter case or separator spelling.
    const from = windowsForm(source)
    const at = windowsForm(path)
    if (at.slice(0, from.length).toLowerCase() !== from.toLowerCase()) return null
    const rest = at.slice(from.length)
    if (rest === '') return target
    return rest.startsWith('\\') ? target + rest : null
  }
  if (path === source) return target
  for (const separator of ['/', '\\']) {
    if (path.startsWith(source + separator)) return target + path.slice(source.length)
  }
  return null
}

function rebase(path: string, sources: readonly string[], target: string): string | null {
  for (const source of sources) {
    const rebased = rebaseOne(path, source, target)
    if (rebased !== null) return rebased
  }
  return null
}

/** One pane of an imported grid: a session pane follows its new id, a file pane its new
 *  folder; panes of sessions or files that did not travel are dropped. */
function remapPane(pane: PaneNode, sessions: Map<number, number>, sources: readonly string[], target: string): PaneNode | null {
  switch (pane.kind) {
    case 'leaf': {
      const session = sessions.get(pane.session)
      return session === undefined ? null : { kind: 'leaf', session, id: newPaneId() }
    }
    case 'editor': {
      const path = rebase(pane.path, sources, target)
      return path === null ? null : { ...pane, id: newPaneId(), path }
    }
    case 'files': {
      if (pane.root === undefined) return { ...pane, id: newPaneId() }
      const root = rebase(pane.root, sources, target)
      return root === null ? null : { ...pane, id: newPaneId(), root }
    }
    default:
      return { ...pane, id: newPaneId() }
  }
}

function remapTree(node: LayoutNode, sessions: Map<number, number>, sources: readonly string[], target: string): LayoutNode | null {
  if (node.kind === 'split') {
    const kept: { node: LayoutNode; weight: number }[] = []
    node.children.forEach((child, index) => {
      const next = remapTree(child, sessions, sources, target)
      if (next) kept.push({ node: next, weight: node.weights[index] ?? 1 })
    })
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0].node
    return { ...node, children: kept.map((k) => k.node), weights: kept.map((k) => k.weight) }
  }
  if (node.kind === 'stack') {
    const children = node.children
      .map((child) => remapPane(child, sessions, sources, target))
      .filter((child): child is PaneNode => child !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return { ...node, id: newPaneId(), children, activeIndex: Math.min(node.activeIndex, children.length - 1) }
  }
  return remapPane(node, sessions, sources, target)
}

export interface PlacedGrids {
  grids: GridMeta[]
  layouts: Array<[string, LayoutState]>
}

/** The imported grids for `target`, with new grid ids, session ids and folders. Grid tags
 *  stay behind: tag ids belong to the other computer's registry. */
export function placeTransferGrids(
  blob: string,
  source: string,
  target: string,
  mapping: readonly TransferSessionMapping[],
  existing: readonly GridMeta[]
): PlacedGrids {
  const parsed = parse(blob)
  if (!parsed) return { grids: [], layouts: [] }
  const sessions = new Map(mapping.map((m) => [m.from, m.to]))
  const recorded = typeof parsed.source === 'string' ? parsed.source : source
  const sources = recorded === source ? [source] : [recorded, source]
  const names = new Set(existing.map((grid) => grid.name))
  const out: PlacedGrids = { grids: [], layouts: [] }
  for (const grid of parsed.grids) {
    const layout = parsed.layouts[grid.id]
    const tree = layout && isLayoutNode(layout.tree) ? remapTree(layout.tree, sessions, sources, target) : null
    if (!tree) continue
    const id = newGridId()
    const name = names.has(grid.name) ? `${grid.name} (transferred)` : grid.name
    names.add(name)
    out.grids.push({ id, name, nameSource: 'user', tags: [] })
    out.layouts.push([gridStorageKey(target, id), { tree, cols: layout.cols }])
  }
  return out
}
