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
  const blob: TransferGrids = { version: 1, grids, layouts }
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

function rebase(path: string, source: string, target: string): string | null {
  if (path === source) return target
  for (const separator of ['/', '\\']) {
    if (path.startsWith(source + separator)) return target + path.slice(source.length)
  }
  return null
}

/** One pane of an imported grid: a session pane follows its new id, a file pane its new
 *  folder; panes of sessions or files that did not travel are dropped. */
function remapPane(pane: PaneNode, sessions: Map<number, number>, source: string, target: string): PaneNode | null {
  switch (pane.kind) {
    case 'leaf': {
      const session = sessions.get(pane.session)
      return session === undefined ? null : { kind: 'leaf', session, id: newPaneId() }
    }
    case 'editor': {
      const path = rebase(pane.path, source, target)
      return path === null ? null : { ...pane, id: newPaneId(), path }
    }
    case 'files': {
      if (pane.root === undefined) return { ...pane, id: newPaneId() }
      const root = rebase(pane.root, source, target)
      return root === null ? null : { ...pane, id: newPaneId(), root }
    }
    default:
      return { ...pane, id: newPaneId() }
  }
}

function remapTree(node: LayoutNode, sessions: Map<number, number>, source: string, target: string): LayoutNode | null {
  if (node.kind === 'split') {
    const kept: { node: LayoutNode; weight: number }[] = []
    node.children.forEach((child, index) => {
      const next = remapTree(child, sessions, source, target)
      if (next) kept.push({ node: next, weight: node.weights[index] ?? 1 })
    })
    if (kept.length === 0) return null
    if (kept.length === 1) return kept[0].node
    return { ...node, children: kept.map((k) => k.node), weights: kept.map((k) => k.weight) }
  }
  if (node.kind === 'stack') {
    const children = node.children
      .map((child) => remapPane(child, sessions, source, target))
      .filter((child): child is PaneNode => child !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return { ...node, id: newPaneId(), children, activeIndex: Math.min(node.activeIndex, children.length - 1) }
  }
  return remapPane(node, sessions, source, target)
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
  const names = new Set(existing.map((grid) => grid.name))
  const out: PlacedGrids = { grids: [], layouts: [] }
  for (const grid of parsed.grids) {
    const layout = parsed.layouts[grid.id]
    const tree = layout && isLayoutNode(layout.tree) ? remapTree(layout.tree, sessions, source, target) : null
    if (!tree) continue
    const id = newGridId()
    const name = names.has(grid.name) ? `${grid.name} (transferred)` : grid.name
    names.add(name)
    out.grids.push({ id, name, nameSource: 'user', tags: [] })
    out.layouts.push([gridStorageKey(target, id), { tree, cols: layout.cols }])
  }
  return out
}
