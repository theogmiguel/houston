import { describe, expect, it } from 'vitest'
import {
  canReorderRailGrid,
  COMPACT_DEFAULT,
  DETAILED_DEFAULT,
  isRailGridUnread,
  loadRailPrefs,
  migratePinnedWorkspaces,
  migrateRailPrefs,
  moveSelectedRailGrid,
  normalizeRailPrefs,
  railUnreadSignature,
  reorderRailGrid,
  saveRailPrefs,
  setRailCardMode,
  toggleRailGridRead,
} from './railPrefs'

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
}

describe('rail preferences', () => {
  it('normalizes invalid or older persisted data to the v1 shape', () => {
    const prefs = normalizeRailPrefs({ v: 0, groupBy: 'repo', properties: ['status', 'invalid'] })
    expect(prefs.v).toBe(1)
    expect(prefs.groupBy).toBe('workspace')
    expect(prefs.properties).toContain('unread')
    expect(prefs.properties).not.toContain('invalid')
  })

  it('migrates tag filters once and leaves workspace collapse under its own key', () => {
    const store = storage({ 'tr-ws-collapsed': '["/repo"]', 'houston.tagFilter': '[2]' })
    const prefs = migrateRailPrefs(store)
    expect(prefs.collapsedGroups).toEqual([])
    expect(store.getItem('tr-ws-collapsed')).toBe('["/repo"]')
    expect(prefs.tags).toEqual([2])
    expect(migrateRailPrefs(store).tags).toEqual([2])
  })

  it('swaps card presets only before the properties are customized', () => {
    const custom = {
      ...normalizeRailPrefs(null),
      properties: [...DETAILED_DEFAULT, 'context' as const],
      customisedProperties: true,
    }
    expect(setRailCardMode(custom, 'compact').properties).toEqual(custom.properties)
    expect(setRailCardMode(normalizeRailPrefs(null), 'compact').properties).toEqual(COMPACT_DEFAULT)
  })

  it('migrates each pinned workspace to all of its grids exactly once', () => {
    const store = storage({ 'tr-ws-pinned': '["/repo"]' })
    const grids = [{ path: '/repo', gridIds: ['a', 'b'] }]
    expect(migratePinnedWorkspaces(grids, new Set(['/repo']), store)).toEqual(['a', 'b'])
    expect(migratePinnedWorkspaces([{ path: '/repo', gridIds: ['c'] }], new Set(['/repo']), store)).toEqual(['a', 'b'])
  })

  it('persists manual grid order and unread overrides while ignoring invalid entries', () => {
    const store = storage()
    saveRailPrefs(
      {
        ...normalizeRailPrefs(null),
        gridOrder: ['b', 'a'],
        gridUnreadOverrides: { a: { signature: 'seen', unread: true } },
      },
      store,
    )
    const persisted = loadRailPrefs(store)
    expect(persisted.gridOrder).toEqual(['b', 'a'])
    expect(persisted.gridUnreadOverrides).toEqual({ a: { signature: 'seen', unread: true } })
    const prefs = normalizeRailPrefs({
      v: 1,
      gridOrder: ['b', 'a', 'b', 2],
      gridUnreadOverrides: { a: { signature: 'seen', unread: false }, b: 4 },
    })
    expect(prefs.gridOrder).toEqual(['b', 'a'])
    expect(prefs.gridUnreadOverrides).toEqual({ a: { signature: 'seen', unread: false } })
  })

  it('moves a rail card before or after a target in manual order', () => {
    expect(reorderRailGrid(['a', 'b', 'c'], 'a', 'c', false)).toEqual(['b', 'c', 'a'])
    expect(reorderRailGrid(['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b'])
    expect(reorderRailGrid(['a', 'b'], 'a', 'missing', true)).toEqual(['a', 'b'])
  })

  it('allows card reordering only in Manual sort within one workspace', () => {
    expect(canReorderRailGrid('manual', '/repo', '/repo')).toBe(true)
    expect(canReorderRailGrid('manual', '/repo', '/other')).toBe(false)
    expect(canReorderRailGrid('smart', '/repo', '/repo')).toBe(false)
  })

  it('moves the selected card one position within its workspace', () => {
    expect(moveSelectedRailGrid(['a', 'b', 'x', 'c'], ['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b', 'x'])
    expect(moveSelectedRailGrid(['a', 'b'], ['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
  })

  it('changes the unread signature when inbox or child-wait counts change', () => {
    const initial = railUnreadSignature([{ id: 4, inboxUnread: 1, childrenWaiting: 0 }])
    expect(railUnreadSignature([{ id: 4, inboxUnread: 1, childrenWaiting: 0 }])).toBe(initial)
    expect(railUnreadSignature([{ id: 4, inboxUnread: 2, childrenWaiting: 0 }])).not.toBe(initial)
    const read = toggleRailGridRead({}, 'g1', initial, true)
    expect(isRailGridUnread(read, 'g1', initial, true)).toBe(false)
    expect(
      isRailGridUnread(read, 'g1', railUnreadSignature([{ id: 4, inboxUnread: 2, childrenWaiting: 0 }]), true),
    ).toBe(true)
    expect(
      isRailGridUnread(
        toggleRailGridRead(read, 'g1', railUnreadSignature([]), false),
        'g1',
        railUnreadSignature([]),
        false,
      ),
    ).toBe(true)
  })
})
