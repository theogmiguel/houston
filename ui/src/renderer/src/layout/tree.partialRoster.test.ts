import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GRID_ID, findPane, gridStorageKey, leaf, preorderSessions, respawnedSessions,
  syncSessionLayout, syncWorkspaceGrids, type LayoutNode, type LayoutState
} from './tree'

const origin = 0x80000000 + 7
const firstReplacement = 0x80000000 + 17
const secondReplacement = 0x80000000 + 27
const pending = (id: number): boolean => id >= 0x80000000
const saved: LayoutNode = {
  kind: 'split', dir: 'row', weights: [70, 30],
  children: [leaf(origin, 'saved-wsl-slot'), leaf(1, 'saved-local-slot')]
}

describe('partial environment rosters', () => {
  it('keeps a missing environment slot and its weights through two replacements with the same origin', () => {
    const local = respawnedSessions([{ id: 1 }])
    let tree = syncSessionLayout(saved, [1], 2, local, [1], pending)
    expect(tree).toEqual(saved)
    const first = respawnedSessions([{ id: 1 }, { id: firstReplacement, session_origin: origin }])
    tree = syncSessionLayout(tree, [1, firstReplacement], 2, first, [1, firstReplacement])
    expect(findPane(tree!, firstReplacement)).toEqual({ ...leaf(firstReplacement, 'saved-wsl-slot'), session_origin: origin })
    expect(tree).toMatchObject({ weights: [70, 30] })

    tree = syncSessionLayout(tree, [1], 2, local, [1], pending)
    expect(preorderSessions(tree)).toEqual([firstReplacement, 1])
    const second = respawnedSessions([{ id: 1 }, { id: secondReplacement, session_origin: origin }])
    tree = syncSessionLayout(tree, [1, secondReplacement], 2, second, [1, secondReplacement])
    expect(tree).toEqual({
      ...saved,
      children: [{ ...leaf(secondReplacement, 'saved-wsl-slot'), session_origin: origin }, leaf(1, 'saved-local-slot')]
    })
  })

  it('prunes absent local sessions immediately and absent WSL sessions once their roster is authoritative', () => {
    const withClosedLocal: LayoutNode = {
      kind: 'split', dir: 'row', weights: [50, 30, 20],
      children: [leaf(origin, 'saved-wsl-slot'), leaf(1, 'saved-local-slot'), leaf(2, 'closed-local-slot')]
    }
    const local = respawnedSessions([{ id: 1 }])
    const retained = syncSessionLayout(withClosedLocal, [1], 2, local, [1], pending)
    expect(preorderSessions(retained)).toEqual([origin, 1])
    expect(syncSessionLayout(retained, [1], 2, local)).toEqual(leaf(1, 'saved-local-slot'))
    expect(syncSessionLayout(retained, [1], 2, local, [1], () => false)).toEqual(leaf(1, 'saved-local-slot'))
  })

  it('retains pending slots in their saved workspace grid without placing them in another grid', () => {
    const path = '/home/test/project'
    const key = gridStorageKey(path, DEFAULT_GRID_ID)
    const otherKey = gridStorageKey(path, 'other')
    const grids = [{ id: DEFAULT_GRID_ID, name: 'First' }, { id: 'other', name: 'Other' }]
    const current = new Map<string, LayoutState>([
      [key, { tree: leaf(origin, 'saved-wsl-slot'), cols: 2 }],
      [otherKey, { tree: null, cols: 2 }]
    ])
    const retained = syncWorkspaceGrids(path, grids, 'other', [], current, new Map(), [], pending)
    expect(retained.get(key)).toEqual(current.get(key))
    expect(retained.get(otherKey)?.tree).toBeNull()
    const replaced = respawnedSessions([{ id: secondReplacement, session_origin: origin }])
    const restored = syncWorkspaceGrids(path, grids, 'other', [secondReplacement], retained, replaced)
    expect(restored.get(key)?.tree).toEqual({ ...leaf(secondReplacement, 'saved-wsl-slot'), session_origin: origin })
    expect(restored.get(otherKey)?.tree).toBeNull()
    const closed = syncWorkspaceGrids(path, grids, 'other', [], restored)
    expect(closed.get(key)?.tree).toBeNull()
  })
})
