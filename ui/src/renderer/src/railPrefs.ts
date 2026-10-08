import { DEFAULT_GRID_ID, gridStorageKey } from './layout/tree'

export type RailGroupBy = 'none' | 'status' | 'pr' | 'workspace'
export type RailSort = 'manual' | 'smart' | 'recent' | 'name'
export type RailCardMode = 'detailed' | 'compact'
export type RailTagDisplay = 'icon' | 'dots' | 'chips'
export type AgentActivityMode = 'compact' | 'full'
export type RailCardProperty =
  'status' | 'unread' | 'checkout' | 'pr' | 'ci' | 'diff' | 'tags' | 'task' | 'inline-agents' | 'context'
export type RailFilters = { hideIdle: boolean; hideDefaultBranch: boolean; hideEmptyGrids: boolean }
export type RailPrefs = {
  v: 1
  groupBy: RailGroupBy
  sort: RailSort
  cardMode: RailCardMode
  tagDisplay: RailTagDisplay
  agentActivity: AgentActivityMode
  properties: RailCardProperty[]
  filters: RailFilters
  collapsedGroups: string[]
  tags: number[]
  customisedProperties: boolean
  gridOrder: string[]
  gridUnreadOverrides: Record<string, { signature: string; unread: boolean }>
}

export const RAIL_PREFS_KEY = 'tr-rail-prefs'
export const GRID_PINNED_KEY = 'tr-grid-pinned'
/** Set once pins were converted to workspace-scoped keys (`path::gridId`); grid ids repeat across workspaces. */
export const GRID_PINNED_MIGRATION_KEY = 'tr-grid-pinned-v2'
/** Set by the first release of the flat rail, which stored bare grid ids. */
export const GRID_PINNED_LEGACY_MIGRATION_KEY = 'tr-grid-pinned-migrated'
export const DETAILED_DEFAULT: RailCardProperty[] = [
  'status',
  'unread',
  'checkout',
  'pr',
  'diff',
  'task',
  'inline-agents',
]
export const COMPACT_DEFAULT: RailCardProperty[] = ['status', 'unread']

export const DEFAULT_RAIL_PREFS: RailPrefs = {
  v: 1,
  groupBy: 'workspace',
  sort: 'manual',
  cardMode: 'detailed',
  tagDisplay: 'icon',
  agentActivity: 'compact',
  properties: [...DETAILED_DEFAULT],
  filters: { hideIdle: false, hideDefaultBranch: false, hideEmptyGrids: false },
  collapsedGroups: [],
  tags: [],
  customisedProperties: false,
  gridOrder: [],
  gridUnreadOverrides: {},
}

const properties = new Set<RailCardProperty>([
  'status',
  'unread',
  'checkout',
  'pr',
  'ci',
  'diff',
  'tags',
  'task',
  'inline-agents',
  'context',
])
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeRailPrefs(value: unknown): RailPrefs {
  if (!object(value))
    return { ...DEFAULT_RAIL_PREFS, filters: { ...DEFAULT_RAIL_PREFS.filters }, properties: [...DETAILED_DEFAULT] }
  const source = value.v === 1 ? value : {}
  const list = Array.isArray(source.properties)
    ? source.properties.filter(
        (entry): entry is RailCardProperty => typeof entry === 'string' && properties.has(entry as RailCardProperty),
      )
    : [...DETAILED_DEFAULT]
  return {
    v: 1,
    groupBy:
      source.groupBy === 'none' ||
      source.groupBy === 'status' ||
      source.groupBy === 'pr' ||
      source.groupBy === 'workspace'
        ? source.groupBy
        : DEFAULT_RAIL_PREFS.groupBy,
    sort:
      source.sort === 'smart' || source.sort === 'recent' || source.sort === 'name' || source.sort === 'manual'
        ? source.sort
        : DEFAULT_RAIL_PREFS.sort,
    cardMode: source.cardMode === 'compact' ? 'compact' : 'detailed',
    tagDisplay: source.tagDisplay === 'dots' || source.tagDisplay === 'chips' ? source.tagDisplay : 'icon',
    agentActivity: source.agentActivity === 'full' ? 'full' : 'compact',
    properties: [...new Set<RailCardProperty>(['status', 'unread', ...list])],
    filters: {
      hideIdle: object(source.filters) && source.filters.hideIdle === true,
      hideDefaultBranch: object(source.filters) && source.filters.hideDefaultBranch === true,
      hideEmptyGrids: object(source.filters) && source.filters.hideEmptyGrids === true,
    },
    collapsedGroups: Array.isArray(source.collapsedGroups)
      ? source.collapsedGroups.filter((entry): entry is string => typeof entry === 'string')
      : [],
    tags: Array.isArray(source.tags) ? source.tags.filter((entry): entry is number => Number.isSafeInteger(entry)) : [],
    customisedProperties: source.customisedProperties === true,
    gridOrder: Array.isArray(source.gridOrder)
      ? [...new Set(source.gridOrder.filter((entry): entry is string => typeof entry === 'string'))]
      : [],
    gridUnreadOverrides: object(source.gridUnreadOverrides)
      ? Object.fromEntries(
          Object.entries(source.gridUnreadOverrides).filter(
            (entry): entry is [string, { signature: string; unread: boolean }] =>
              object(entry[1]) && typeof entry[1].signature === 'string' && typeof entry[1].unread === 'boolean',
          ),
        )
      : {},
  }
}

export function reorderRailGrid(order: readonly string[], gridId: string, targetId: string, before: boolean): string[] {
  const next = [...order]
  const from = next.indexOf(gridId)
  const target = next.indexOf(targetId)
  if (from < 0 || target < 0 || from === target) return next
  next.splice(from, 1)
  const adjustedTarget = next.indexOf(targetId)
  next.splice(adjustedTarget + Number(!before), 0, gridId)
  return next
}

export function canReorderRailGrid(sort: RailSort, sourceWorkspace: string, targetWorkspace: string): boolean {
  return sort === 'manual' && sourceWorkspace === targetWorkspace
}

export function moveSelectedRailGrid(
  order: readonly string[],
  workspaceIds: readonly string[],
  gridId: string,
  direction: -1 | 1,
): string[] {
  const visibleOrder = workspaceIds.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const index = visibleOrder.indexOf(gridId)
  const target = visibleOrder[index + direction]
  return target ? reorderRailGrid(order, gridId, target, direction < 0) : [...order]
}

export function railUnreadSignature(
  agents: readonly { id: number; inboxUnread: number; childrenWaiting: number }[],
): string {
  return JSON.stringify(agents.map(({ id, inboxUnread, childrenWaiting }) => [id, inboxUnread, childrenWaiting]))
}

export function isRailGridUnread(
  overrides: RailPrefs['gridUnreadOverrides'],
  gridId: string,
  signature: string,
  sourceUnread: boolean,
): boolean {
  const override = overrides[gridId]
  return override?.signature === signature ? override.unread : sourceUnread
}

export function toggleRailGridRead(
  overrides: RailPrefs['gridUnreadOverrides'],
  gridId: string,
  signature: string,
  unread: boolean,
): RailPrefs['gridUnreadOverrides'] {
  const next = { ...overrides }
  next[gridId] = { signature, unread: !unread }
  return next
}

export function loadRailPrefs(storage: Pick<Storage, 'getItem'> = localStorage): RailPrefs {
  try {
    return normalizeRailPrefs(JSON.parse(storage.getItem(RAIL_PREFS_KEY) ?? 'null'))
  } catch {
    return normalizeRailPrefs(null)
  }
}

export function migrateRailPrefs(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): RailPrefs {
  const current = loadRailPrefs(storage)
  if (storage.getItem(RAIL_PREFS_KEY) !== null) return current
  let tags: number[] = []
  try {
    const raw = JSON.parse(storage.getItem('houston.tagFilter') ?? '[]') as unknown
    if (Array.isArray(raw)) tags = raw.filter((entry): entry is number => Number.isSafeInteger(entry))
  } catch {
    /* Ignore stale preference data. */
  }
  const migrated = { ...current, tags }
  saveRailPrefs(migrated, storage)
  return migrated
}

export function saveRailPrefs(prefs: RailPrefs, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify(normalizeRailPrefs(prefs)))
  } catch {
    /* Storage can be unavailable in private contexts. */
  }
}

export function setRailCardMode(prefs: RailPrefs, mode: RailCardMode): RailPrefs {
  const propertiesForMode = mode === 'detailed' ? DETAILED_DEFAULT : COMPACT_DEFAULT
  return {
    ...prefs,
    cardMode: mode,
    properties: prefs.customisedProperties ? prefs.properties : [...propertiesForMode],
  }
}

export function loadPinnedGridIds(storage: Pick<Storage, 'getItem'> = localStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(GRID_PINNED_KEY) ?? '[]')
    return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))] : []
  } catch {
    return []
  }
}

type GridKnowledge = readonly { path: string; gridIds: readonly string[] }[]

/**
 * Resolves a stored grid reference to a workspace-scoped key. Bare `g-default` exists in every
 * workspace, so it cannot be attributed and yields null; other bare ids map to the one workspace
 * holding them, or null when no loaded workspace does.
 */
function scopedGridKey(entry: string, workspaces: GridKnowledge): string | null {
  if (entry.includes('::')) return entry
  if (entry === DEFAULT_GRID_ID) return null
  const owner = workspaces.find((workspace) => workspace.gridIds.includes(entry))
  return owner ? gridStorageKey(owner.path, entry) : null
}

/** Rewrites bare grid ids in the manual order and unread overrides to workspace-scoped keys. Idempotent. */
export function migrateRailGridKeys(prefs: RailPrefs, workspaces: GridKnowledge): RailPrefs {
  const gridOrder = [
    ...new Set(prefs.gridOrder.flatMap((entry) => {
      const key = scopedGridKey(entry, workspaces)
      return key ? [key] : []
    })),
  ]
  const gridUnreadOverrides: RailPrefs['gridUnreadOverrides'] = {}
  for (const [entry, override] of Object.entries(prefs.gridUnreadOverrides)) {
    const key = scopedGridKey(entry, workspaces)
    if (key) gridUnreadOverrides[key] = override
  }
  const unchanged =
    gridOrder.length === prefs.gridOrder.length &&
    gridOrder.every((entry, index) => entry === prefs.gridOrder[index]) &&
    Object.keys(gridUnreadOverrides).length === Object.keys(prefs.gridUnreadOverrides).length &&
    Object.keys(gridUnreadOverrides).every((key) => key in prefs.gridUnreadOverrides)
  return unchanged ? prefs : { ...prefs, gridOrder, gridUnreadOverrides }
}

export function migratePinnedWorkspaces(
  workspaces: GridKnowledge,
  pinnedWorkspacePaths: ReadonlySet<string>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): string[] {
  const existing = loadPinnedGridIds(storage)
  if (storage.getItem(GRID_PINNED_MIGRATION_KEY) === '1') return existing
  const converted = existing.flatMap((entry) => {
    if (entry !== DEFAULT_GRID_ID) {
      const key = scopedGridKey(entry, workspaces)
      return key ? [key] : []
    }
    // Bare g-default was written for every workspace by the first migration, so only pinned workspaces keep it.
    return workspaces.filter((workspace) => pinnedWorkspacePaths.has(workspace.path) && workspace.gridIds.includes(entry))
      .map((workspace) => gridStorageKey(workspace.path, entry))
  })
  const fromWorkspacePins = storage.getItem(GRID_PINNED_LEGACY_MIGRATION_KEY) === '1'
    ? []
    : workspaces
        .filter((workspace) => pinnedWorkspacePaths.has(workspace.path))
        .flatMap((workspace) => workspace.gridIds.map((id) => gridStorageKey(workspace.path, id)))
  const migrated = [...new Set([...converted, ...fromWorkspacePins])]
  try {
    storage.setItem(GRID_PINNED_KEY, JSON.stringify(migrated))
    storage.setItem(GRID_PINNED_MIGRATION_KEY, '1')
  } catch {
    /* Storage can be unavailable in private contexts. */
  }
  return migrated
}
