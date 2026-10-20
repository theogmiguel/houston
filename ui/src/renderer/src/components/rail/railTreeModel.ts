import type { SessionInfo, Workspace } from '../../houston/client'
import { gridStorageKey, isAutoNameable } from '../../layout/tree'
import type { RailPrefs } from '../../railPrefs'
import type { RailPrState } from '../git/railPrCache'
import type { RailDiffTotals } from '../git/useRailGitFacts'
import { buildRailCard, type RailCard } from './railCardModel'

export type GridItem = {
  id: string
  name: string
  count?: number
  state?: 'starting' | 'working' | 'needs-input' | 'idle' | 'unavailable' | 'stopped'
  statusLabel?: string
  sessionIds?: number[]
  tagIds?: number[]
  paneTagIds?: number[]
  childCount?: number
  /** True when the user chose the name, so it can be handed back to automatic naming. */
  userNamed?: boolean
}

export interface RailEntry {
  workspace: Workspace
  grid: GridItem
  paneIds: number[]
  card: RailCard
}

export interface RailEntryInput {
  workspaces: readonly Workspace[]
  gridsByWorkspace: Record<string, GridItem[]>
  activeTagIds: readonly number[]
  sessions: SessionInfo[]
  pinnedGridIds: ReadonlySet<string>
  branches: ReadonlyMap<number, string>
  diffByDir: ReadonlyMap<string, RailDiffTotals>
  prByDir: ReadonlyMap<string, RailPrState>
  filters: RailPrefs['filters']
  selected: string
  selectedGridId: string | null
  finishedUnseen?: ReadonlySet<number>
}

export const entryKey = (entry: { workspace: Workspace; grid: GridItem }): string =>
  gridStorageKey(entry.workspace.path, entry.grid.id)

// A tab whose own and panes' tags carry no active tag leaves the rail. Unknown
// pane membership (paneTagIds undefined) stays: never hide what it cannot see.
export function hiddenByTagFilter(
  g: Pick<GridItem, 'tagIds' | 'paneTagIds'>,
  activeTagIds: readonly number[],
): boolean {
  if (activeTagIds.length === 0) return false
  const carries = (ids: number[] | undefined): boolean => ids?.some((id) => activeTagIds.includes(id)) ?? false
  if (carries(g.tagIds)) return false
  return g.paneTagIds !== undefined && !carries(g.paneTagIds)
}

// A workspace that never ran a session owns one empty, auto-named grid; listing it reads as the app creating grids.
export function isPlaceholderGrid(
  grids: readonly GridItem[] | undefined,
  grid: GridItem,
  isSelected: boolean,
): boolean {
  return (
    (grids?.length ?? 0) === 1 &&
    (grid.sessionIds?.length ?? 0) === 0 &&
    isAutoNameable({ id: grid.id, name: grid.name }) &&
    !isSelected
  )
}

export function isGridFilterActive(filters: RailPrefs['filters'], activeTagIds: readonly number[]): boolean {
  return activeTagIds.length > 0 || filters.hideIdle || filters.hideEmptyGrids || filters.hideDefaultBranch
}

/** Every card the rail may show. The selected grid is exempt from every filter. */
export function buildRailEntries(input: RailEntryInput): RailEntry[] {
  const { gridsByWorkspace, activeTagIds, filters, selected, selectedGridId } = input
  return input.workspaces.flatMap((workspace) => (gridsByWorkspace[workspace.path] ?? []).flatMap((grid) => {
    const isSelected = selected === workspace.path && selectedGridId === grid.id
    if (isPlaceholderGrid(gridsByWorkspace[workspace.path], grid, isSelected)) return []
    if (!isSelected && hiddenByTagFilter(grid, activeTagIds)) return []
    const paneIds = grid.sessionIds ?? []
    const card = buildRailCard({
      gridId: grid.id,
      workspace: workspace.path,
      title: grid.name,
      pinned: input.pinnedGridIds.has(gridStorageKey(workspace.path, grid.id)),
      paneIds,
      sessions: input.sessions,
      branches: input.branches,
      diffByDir: input.diffByDir,
      prByDir: input.prByDir,
      finishedUnseen: input.finishedUnseen,
    })
    if (!isSelected) {
      if (filters.hideIdle && ['idle', 'done'].includes(card.status.kind)) return []
      if (filters.hideEmptyGrids && paneIds.length === 0) return []
      if (filters.hideDefaultBranch && card.checkouts.some(
        (checkout) => 'branch' in checkout && ['main', 'master'].includes(checkout.branch ?? ''),
      )) return []
    }
    return [{ workspace, grid, paneIds, card }]
  }))
}

export interface RailTreeGroup {
  key: string
  label: string
  kind: 'pinned' | 'workspace' | 'label'
  workspace?: Workspace
  /** Index among the displayed workspaces; the drag drop index counts these. */
  wsIndex: number
  cards: RailEntry[]
  collapsed: boolean
  /** True when the selected card is listed under this group's own header. */
  selectedCardListed: boolean
}

export interface RailTreeModel {
  groups: RailTreeGroup[]
  /** Cards in on-screen order (collapsed groups skipped); Alt+1..9 and the card numbers follow it. */
  jumpOrder: { path: string; gridId: string; key: string }[]
  jumpByKey: ReadonlyMap<string, number>
  displayedWorkspaces: Workspace[]
}

export interface RailLayoutInput {
  entries: RailEntry[]
  workspaces: readonly Workspace[]
  gridsByWorkspace: Record<string, GridItem[]>
  prefs: Pick<RailPrefs, 'filters' | 'sort' | 'groupBy' | 'collapsedGroups' | 'gridOrder'>
  activeTagIds: readonly number[]
  selected: string
  selectedGridId: string | null
  isWsOpen: (path: string) => boolean
  /** Cards as they stood when the smart ranking last settled. */
  settled: ReadonlyMap<string, RailCard>
}

const smartRank = (card: RailCard): number =>
  card.status.kind === 'needs-input' ? 0 : card.status.kind === 'working' ? 1 : card.agents.some((agent) => agent.unread) ? 2 : 3

export function sortRailEntries(
  cards: RailEntry[],
  prefs: Pick<RailPrefs, 'sort' | 'gridOrder'>,
  settled: ReadonlyMap<string, RailCard>,
): RailEntry[] {
  if (prefs.sort === 'name') return [...cards].sort((a, b) => a.grid.name.localeCompare(b.grid.name))
  if (prefs.sort === 'recent') return [...cards].sort((a, b) => b.card.lastActivityMs - a.card.lastActivityMs)
  if (prefs.sort === 'smart') return [...cards].sort((a, b) => {
    const left = settled.get(entryKey(a)) ?? a.card
    const right = settled.get(entryKey(b)) ?? b.card
    return smartRank(left) - smartRank(right) || right.lastActivityMs - left.lastActivityMs
  })
  const order = new Map(prefs.gridOrder.map((id, index) => [id, index]))
  return [...cards].sort((left, right) =>
    (order.get(entryKey(left)) ?? Number.MAX_SAFE_INTEGER) - (order.get(entryKey(right)) ?? Number.MAX_SAFE_INTEGER),
  )
}

const STATUS_GROUPS = ['Needs you', 'Working', 'Done', 'Idle']
const PR_GROUPS = ['Pull requests', 'No pull request']

export function layoutRailTree(input: RailLayoutInput): RailTreeModel {
  const { entries, prefs, selected, selectedGridId, gridsByWorkspace } = input
  const isSelected = (entry: RailEntry): boolean => selected === entry.workspace.path && selectedGridId === entry.grid.id
  const pinned = sortRailEntries(entries.filter(({ card }) => card.pinned), prefs, input.settled)
  const unpinned = sortRailEntries(entries.filter(({ card }) => !card.pinned), prefs, input.settled)
  const groups: RailTreeGroup[] = []
  if (pinned.length > 0) {
    groups.push({
      key: 'group:pinned', label: 'Pinned', kind: 'pinned', wsIndex: 0, cards: pinned,
      collapsed: prefs.collapsedGroups.includes('Pinned'), selectedCardListed: pinned.some(isSelected),
    })
  }
  let displayedWorkspaces: Workspace[] = []
  if (prefs.groupBy === 'workspace') {
    const filterActive = isGridFilterActive(prefs.filters, input.activeTagIds)
    displayedWorkspaces = input.workspaces.filter((workspace) => {
      if (!filterActive || selected === workspace.path) return true
      const grids = gridsByWorkspace[workspace.path] ?? []
      const hasRealGrids = grids.some((grid) => !isPlaceholderGrid(grids, grid, false))
      return !hasRealGrids || entries.some((entry) => entry.workspace.path === workspace.path)
    })
    displayedWorkspaces.forEach((workspace, wsIndex) => {
      const cards = unpinned.filter((entry) => entry.workspace.path === workspace.path)
      const collapsed = !input.isWsOpen(workspace.path)
      groups.push({
        key: `group:${workspace.path}`, label: workspace.name, kind: 'workspace', workspace, wsIndex, cards, collapsed,
        selectedCardListed: !collapsed && cards.some(isSelected),
      })
    })
  } else {
    const byLabel = new Map<string, RailEntry[]>()
    for (const entry of unpinned) {
      const card = prefs.sort === 'smart' ? input.settled.get(entryKey(entry)) ?? entry.card : entry.card
      const label = prefs.groupBy === 'none' ? ''
        : prefs.groupBy === 'status'
          ? card.status.kind === 'needs-input' ? 'Needs you'
            : card.status.kind === 'working' || card.status.kind === 'starting' ? 'Working'
              : card.status.kind === 'done' ? 'Done' : 'Idle'
          : entry.card.pr?.pr ? 'Pull requests' : 'No pull request'
      byLabel.set(label, [...(byLabel.get(label) ?? []), entry])
    }
    const rank = prefs.groupBy === 'status' ? STATUS_GROUPS : PR_GROUPS
    for (const [label, cards] of [...byLabel.entries()].sort(([a], [b]) => rank.indexOf(a) - rank.indexOf(b))) {
      const collapsed = label !== '' && prefs.collapsedGroups.includes(label)
      groups.push({ key: `group:${label}`, label, kind: 'label', wsIndex: 0, cards, collapsed, selectedCardListed: !collapsed && cards.some(isSelected) })
    }
  }
  const jumpOrder = groups.flatMap((group) => group.collapsed ? [] : group.cards.map((entry) => ({
    path: entry.workspace.path, gridId: entry.grid.id, key: entryKey(entry),
  })))
  return {
    groups,
    jumpOrder,
    jumpByKey: new Map(jumpOrder.map((entry, index) => [entry.key, index + 1])),
    displayedWorkspaces,
  }
}

/** Names the active filters for the empty-list message. */
export function describeActiveFilters(filters: RailPrefs['filters'], activeTagIds: readonly number[]): string[] {
  return [
    ...(activeTagIds.length > 0 ? [activeTagIds.length === 1 ? 'a tag filter' : `${activeTagIds.length} tag filters`] : []),
    ...(filters.hideIdle ? ['Hide idle grids'] : []),
    ...(filters.hideDefaultBranch ? ['Hide grids on default branch'] : []),
    ...(filters.hideEmptyGrids ? ['Hide empty grids'] : []),
  ]
}

export function railEmptyMessage(args: {
  workspaceCount: number
  filters: RailPrefs['filters']
  activeTagIds: readonly number[]
}): string {
  if (args.workspaceCount === 0) return 'No workspaces yet.'
  const active = describeActiveFilters(args.filters, args.activeTagIds)
  if (active.length === 0) return 'No grids yet. Create one with New grid.'
  if (args.activeTagIds.length > 0 && active.length === 1) {
    return `No grid carries ${args.activeTagIds.length === 1 ? 'that tag' : 'any of those tags'}. Clear the filter in Sidebar options.`
  }
  return `No grids match the active filters (${active.join(', ')}). Change them in Sidebar options.`
}


// The grid of `path` to select once `gridId` closes: the next card on screen, the previous when it
// was last, or null when the workspace lists no other card.
export function neighbourGridId(model: RailTreeModel, path: string, gridId: string): string | null {
  const cards = model.groups.flatMap((group) => group.cards).filter((entry) => entry.workspace.path === path)
  const index = cards.findIndex((entry) => entry.grid.id === gridId)
  if (index < 0) return null
  return (cards[index + 1] ?? cards[index - 1])?.grid.id ?? null
}

/** Agents spawned, at any depth, by `paneIds` that are not themselves panes of the grid. */
export function countGridChildren(sessions: readonly SessionInfo[], paneIds: readonly number[]): number {
  const known = new Set(paneIds)
  let frontier = new Set(paneIds)
  let found = 0
  while (frontier.size > 0) {
    const next = new Set<number>()
    for (const session of sessions) {
      if (session.spawned_by == null || !frontier.has(session.spawned_by) || known.has(session.id)) continue
      known.add(session.id)
      next.add(session.id)
      found += 1
    }
    frontier = next
  }
  return found
}

/** Where the workspace drop indicator goes: nowhere while no drag runs or when the drop would not move the row. */
export function visibleDropSlot(displayed: readonly Workspace[], dragPath: string | null, dropIndex: number | null): number | null {
  if (dragPath === null || dropIndex === null) return null
  const from = displayed.findIndex((workspace) => workspace.path === dragPath)
  return dropIndex === from || dropIndex === from + 1 ? null : dropIndex
}

/** The list key of the selected card. */
export function selectedCardItemKey(selected: string, selectedGridId: string | null): string | null {
  return selectedGridId === null ? null : `card:${gridStorageKey(selected, selectedGridId)}`
}
