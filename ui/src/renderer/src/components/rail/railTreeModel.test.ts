import { describe, expect, it } from 'vitest'
import type { SessionInfo, Workspace } from '../../houston/client'
import { DEFAULT_RAIL_PREFS } from '../../railPrefs'
import {
  buildRailEntries,
  countGridChildren,
  layoutRailTree,
  neighbourGridId,
  railEmptyMessage,
  type GridItem,
  type RailEntryInput,
} from './railTreeModel'

const ws = (path: string, name = path): Workspace => ({ path, name }) as Workspace
const A = ws('/a', 'alpha')
const B = ws('/b', 'bravo')
const grid = (id: string, sessionIds: number[] = [1]): GridItem => ({ id, name: `grid ${id}`, sessionIds })

function entryInput(overrides: Partial<RailEntryInput> = {}): RailEntryInput {
  return {
    workspaces: [A, B],
    gridsByWorkspace: { '/a': [grid('a1'), grid('a2'), grid('a3')], '/b': [grid('b1')] },
    activeTagIds: [],
    sessions: [],
    pinnedGridIds: new Set(),
    branches: new Map(),
    diffByDir: new Map(),
    prByDir: new Map(),
    filters: DEFAULT_RAIL_PREFS.filters,
    selected: '/a',
    selectedGridId: 'a1',
    ...overrides,
  }
}

function model(input: RailEntryInput, extra: { collapsed?: string[]; collapsedGroups?: string[]; groupBy?: 'workspace' | 'none' } = {}) {
  const entries = buildRailEntries(input)
  return layoutRailTree({
    entries,
    workspaces: input.workspaces,
    gridsByWorkspace: input.gridsByWorkspace,
    prefs: { ...DEFAULT_RAIL_PREFS, filters: input.filters, groupBy: extra.groupBy ?? 'workspace', collapsedGroups: extra.collapsedGroups ?? [] },
    activeTagIds: input.activeTagIds,
    selected: input.selected,
    selectedGridId: input.selectedGridId,
    isWsOpen: (path) => !(extra.collapsed ?? []).includes(path),
    settled: new Map(),
  })
}

describe('layoutRailTree', () => {
  it('numbers cards in on-screen order: pinned first, then each workspace', () => {
    const tree = model(entryInput({ pinnedGridIds: new Set(['/a::a3']) }))
    expect(tree.jumpOrder.map((entry) => entry.key)).toEqual(['/a::a3', '/a::a1', '/a::a2', '/b::b1'])
    expect(tree.jumpByKey.get('/a::a3')).toBe(1)
    expect(tree.jumpByKey.get('/b::b1')).toBe(4)
  })

  it('skips cards of collapsed workspaces and groups', () => {
    const collapsedWs = model(entryInput(), { collapsed: ['/a'] })
    expect(collapsedWs.jumpOrder.map((entry) => entry.key)).toEqual(['/b::b1'])
    const collapsedPinned = model(entryInput({ pinnedGridIds: new Set(['/a::a3']) }), { collapsedGroups: ['Pinned'] })
    expect(collapsedPinned.jumpOrder.map((entry) => entry.key)).toEqual(['/a::a1', '/a::a2', '/b::b1'])
  })

  it('keeps the selected grid under every filter', () => {
    const filters = { hideIdle: false, hideDefaultBranch: false, hideEmptyGrids: true }
    const input = entryInput({
      filters,
      gridsByWorkspace: { '/a': [grid('a1', []), grid('a2', []), grid('a3')], '/b': [grid('b1')] },
    })
    expect(model(input).jumpOrder.map((entry) => entry.key)).toEqual(['/a::a1', '/a::a3', '/b::b1'])
  })

  it('keeps the selected grid when a tag filter would hide it', () => {
    const input = entryInput({
      activeTagIds: [7],
      gridsByWorkspace: { '/a': [{ ...grid('a1'), tagIds: [], paneTagIds: [] }, { ...grid('a2'), tagIds: [7] }], '/b': [{ ...grid('b1'), tagIds: [], paneTagIds: [] }] },
    })
    expect(model(input).jumpOrder.map((entry) => entry.key)).toEqual(['/a::a1', '/a::a2'])
  })

  it('keeps the row of a workspace whose grids are all pinned, with no cards of its own', () => {
    const tree = model(entryInput({ pinnedGridIds: new Set(['/b::b1']) }))
    const group = tree.groups.find((candidate) => candidate.workspace?.path === '/b')
    expect(group?.cards).toEqual([])
    expect(tree.groups[0].kind).toBe('pinned')
  })

  it('hides a workspace with no card under a grid filter, but not the selected one or one without grids', () => {
    const filters = { hideIdle: false, hideDefaultBranch: false, hideEmptyGrids: true }
    const C = ws('/c', 'charlie')
    const input = entryInput({
      filters,
      workspaces: [A, B, C],
      selected: '/a',
      selectedGridId: 'a1',
      gridsByWorkspace: { '/a': [grid('a1')], '/b': [grid('b1', [])], '/c': [] },
    })
    expect(model(input).displayedWorkspaces.map((workspace) => workspace.path)).toEqual(['/a', '/c'])
    expect(model(entryInput({ ...input, selected: '/b', selectedGridId: 'b1' })).displayedWorkspaces.map((workspace) => workspace.path)).toEqual(['/a', '/b', '/c'])
  })

  it('lists every workspace when no grid filter is active', () => {
    const input = entryInput({ gridsByWorkspace: { '/a': [grid('a1')], '/b': [grid('b1', [])] } })
    expect(model(input).displayedWorkspaces).toHaveLength(2)
  })

  it('flags whether the selected card is listed under its workspace row', () => {
    const open = model(entryInput())
    expect(open.groups.find((group) => group.workspace?.path === '/a')?.selectedCardListed).toBe(true)
    const collapsed = model(entryInput(), { collapsed: ['/a'] })
    expect(collapsed.groups.find((group) => group.workspace?.path === '/a')?.selectedCardListed).toBe(false)
  })

  it('shows no workspace rows when grouped by none', () => {
    expect(model(entryInput(), { groupBy: 'none' }).displayedWorkspaces).toEqual([])
  })
})

describe('neighbourGridId', () => {
  const tree = model(entryInput({ pinnedGridIds: new Set(['/a::a3']) }))

  it('takes the next card in on-screen order', () => {
    expect(neighbourGridId(tree, '/a', 'a3')).toBe('a1')
    expect(neighbourGridId(tree, '/a', 'a1')).toBe('a2')
  })

  it('takes the previous card when the closed one is last in its workspace', () => {
    expect(neighbourGridId(tree, '/a', 'a2')).toBe('a1')
  })

  it('is null when the workspace lists no other card', () => {
    expect(neighbourGridId(tree, '/b', 'b1')).toBeNull()
  })
})

describe('countGridChildren', () => {
  const session = (id: number, spawnedBy: number | null): SessionInfo => ({ id, spawned_by: spawnedBy }) as SessionInfo

  it('counts agents spawned at any depth by the grid panes', () => {
    expect(countGridChildren([session(1, null), session(2, 1), session(3, 2), session(4, null)], [1])).toBe(2)
  })

  it('does not count the panes themselves', () => {
    expect(countGridChildren([session(1, null), session(2, 1)], [1, 2])).toBe(0)
  })
})

describe('railEmptyMessage', () => {
  const none = DEFAULT_RAIL_PREFS.filters

  it('says there are no workspaces before anything else', () => {
    expect(railEmptyMessage({ workspaceCount: 0, filters: none, activeTagIds: [] })).toBe('No workspaces yet.')
  })

  it('invites a first grid when no filter is active', () => {
    expect(railEmptyMessage({ workspaceCount: 1, filters: none, activeTagIds: [] })).toBe('No grids yet. Create one with New grid.')
  })

  it('speaks of grids, not tabs, for a tag filter', () => {
    const message = railEmptyMessage({ workspaceCount: 1, filters: none, activeTagIds: [1] })
    expect(message).toContain('No grid carries that tag')
    expect(message).not.toContain('tab')
  })

  it('names the active filters', () => {
    const message = railEmptyMessage({ workspaceCount: 1, filters: { ...none, hideIdle: true, hideEmptyGrids: true }, activeTagIds: [] })
    expect(message).toContain('Hide idle grids')
    expect(message).toContain('Hide empty grids')
  })
})
