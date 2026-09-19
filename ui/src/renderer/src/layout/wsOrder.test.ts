import { describe, expect, it } from 'vitest'
import {
  applyOrder,
  partitionPinned,
  reorder,
  reorderPinned,
  translateFilteredDropIndex
} from './wsOrder'
import type { Workspace } from '../houston/client'

const ws = (path: string): Workspace => ({ path, name: path })

describe('applyOrder', () => {
  it('sorts workspaces by the saved order', () => {
    const workspaces = [ws('/a'), ws('/b'), ws('/c')]
    expect(applyOrder(workspaces, ['/c', '/a', '/b']).map((w) => w.path)).toEqual([
      '/c',
      '/a',
      '/b'
    ])
  })

  it('appends a workspace missing from the saved order, in incoming order', () => {
    const workspaces = [ws('/a'), ws('/b'), ws('/c')]
    expect(applyOrder(workspaces, ['/b']).map((w) => w.path)).toEqual(['/b', '/a', '/c'])
  })

  it('ignores a stale path with no matching workspace', () => {
    const workspaces = [ws('/a'), ws('/b')]
    expect(applyOrder(workspaces, ['/ghost', '/b', '/a']).map((w) => w.path)).toEqual([
      '/b',
      '/a'
    ])
  })

  it('returns the incoming order unchanged when the saved order is empty', () => {
    const workspaces = [ws('/a'), ws('/b')]
    expect(applyOrder(workspaces, []).map((w) => w.path)).toEqual(['/a', '/b'])
  })
})

describe('reorder', () => {
  it('moves a path to a middle index (dragged downward onto the lower half)', () => {
    expect(reorder(['/a', '/b', '/c', '/d'], '/a', 2)).toEqual(['/b', '/a', '/c', '/d'])
  })

  it('moves a path to the first position', () => {
    expect(reorder(['/a', '/b', '/c'], '/c', 0)).toEqual(['/c', '/a', '/b'])
  })

  it('moves a path to the last position (dragged downward past the last row)', () => {
    expect(reorder(['/a', '/b', '/c', '/d'], '/a', 3)).toEqual(['/b', '/c', '/a', '/d'])
  })

  it('inserts a path not already present', () => {
    expect(reorder(['/a', '/b'], '/c', 1)).toEqual(['/a', '/c', '/b'])
  })

  it('leaves an upward drag alone (toIndex already below fromIndex)', () => {
    expect(reorder(['/a', '/b', '/c', '/d'], '/d', 1)).toEqual(['/a', '/d', '/b', '/c'])
  })

  it('round-trips every (source, target, half) combination through applyOrder', () => {
    const workspaces = ['/a', '/b', '/c', '/d'].map((path) => ({ path, name: path }))
    const cases: { from: string; targetIdx: number; half: 'upper' | 'lower'; want: string[] }[] = [
      { from: '/a', targetIdx: 1, half: 'upper', want: ['/a', '/b', '/c', '/d'] },
      { from: '/a', targetIdx: 1, half: 'lower', want: ['/b', '/a', '/c', '/d'] },
      { from: '/a', targetIdx: 2, half: 'upper', want: ['/b', '/a', '/c', '/d'] },
      { from: '/a', targetIdx: 2, half: 'lower', want: ['/b', '/c', '/a', '/d'] },
      { from: '/a', targetIdx: 3, half: 'upper', want: ['/b', '/c', '/a', '/d'] },
      { from: '/a', targetIdx: 3, half: 'lower', want: ['/b', '/c', '/d', '/a'] },
      { from: '/d', targetIdx: 0, half: 'upper', want: ['/d', '/a', '/b', '/c'] },
      { from: '/d', targetIdx: 0, half: 'lower', want: ['/a', '/d', '/b', '/c'] },
      { from: '/d', targetIdx: 1, half: 'upper', want: ['/a', '/d', '/b', '/c'] },
      { from: '/d', targetIdx: 1, half: 'lower', want: ['/a', '/b', '/d', '/c'] },
      { from: '/d', targetIdx: 2, half: 'upper', want: ['/a', '/b', '/d', '/c'] },
      { from: '/d', targetIdx: 2, half: 'lower', want: ['/a', '/b', '/c', '/d'] }
    ]
    const order = workspaces.map((w) => w.path)
    for (const { from, targetIdx, half, want } of cases) {
      const toIndex = half === 'upper' ? targetIdx : targetIdx + 1
      const newOrder = reorder(order, from, toIndex)
      expect(applyOrder(workspaces, newOrder).map((w) => w.path)).toEqual(want)
    }
  })
})

describe('partitionPinned', () => {
  it('splits pinned first, unpinned second, each preserving relative order', () => {
    const workspaces = [ws('/a'), ws('/b'), ws('/c'), ws('/d')]
    const { pinned, unpinned } = partitionPinned(workspaces, new Set(['/c', '/a']))
    expect(pinned.map((w) => w.path)).toEqual(['/a', '/c'])
    expect(unpinned.map((w) => w.path)).toEqual(['/b', '/d'])
  })

  it('returns an empty pinned group when nothing is pinned', () => {
    const workspaces = [ws('/a'), ws('/b')]
    const { pinned, unpinned } = partitionPinned(workspaces, new Set())
    expect(pinned).toEqual([])
    expect(unpinned.map((w) => w.path)).toEqual(['/a', '/b'])
  })

  it('drops a stale pinned path with no matching workspace', () => {
    const workspaces = [ws('/a'), ws('/b')]
    const { pinned, unpinned } = partitionPinned(workspaces, new Set(['/ghost', '/a']))
    expect(pinned.map((w) => w.path)).toEqual(['/a'])
    expect(unpinned.map((w) => w.path)).toEqual(['/b'])
  })
})

describe('reorderPinned', () => {
  const displayed = [ws('/p1'), ws('/p2'), ws('/u1'), ws('/u2'), ws('/u3')]
  const pinned = new Set(['/p1', '/p2'])

  it('reorders within the pinned group and leaves the unpinned group untouched', () => {
    const next = reorderPinned(displayed, pinned, '/p2', 0)
    expect(next).toEqual(['/p2', '/p1', '/u1', '/u2', '/u3'])
  })

  it('reorders within the unpinned group and leaves the pinned group untouched', () => {
    const next = reorderPinned(displayed, pinned, '/u3', 2)
    expect(next).toEqual(['/p1', '/p2', '/u3', '/u1', '/u2'])
  })

  it('clamps a pinned drag at the end of the pinned group, never past it', () => {
    const next = reorderPinned(displayed, pinned, '/p1', 4)
    expect(next).toEqual(['/p2', '/p1', '/u1', '/u2', '/u3'])
  })

  it('clamps an unpinned drag at the start of the unpinned group, never before it', () => {
    const next = reorderPinned(displayed, pinned, '/u2', 0)
    expect(next).toEqual(['/p1', '/p2', '/u2', '/u1', '/u3'])
  })

  it('a pin/unpin/drag round trip never duplicates or drops a workspace', () => {
    const next = reorderPinned(displayed, pinned, '/p1', 2)
    expect([...next].sort()).toEqual(displayed.map((w) => w.path).sort())
  })
})

describe('translateFilteredDropIndex', () => {
  const all = [ws('/p1'), ws('/p2'), ws('/u1'), ws('/u2'), ws('/u3')]
  const pinned = new Set(['/p1', '/p2'])

  it('a hidden pinned row shifts the unpinned boundary the filtered index was computed against', () => {
    const filtered = [ws('/p1'), ws('/p2'), ws('/u2'), ws('/u3')]
    const full = translateFilteredDropIndex(all, filtered, pinned, '/u3', 2)
    expect(reorderPinned(all, pinned, '/u3', full)).toEqual(['/p1', '/p2', '/u1', '/u3', '/u2'])
  })

  it('a hidden PINNED row also shifts the boundary an unpinned drag reads its index against', () => {
    const filtered = [ws('/p2'), ws('/u1'), ws('/u2'), ws('/u3')]
    const full = translateFilteredDropIndex(all, filtered, pinned, '/u3', 2)
    expect(reorderPinned(all, pinned, '/u3', full)).toEqual(['/p1', '/p2', '/u1', '/u3', '/u2'])
  })

  it('an unpinned drag past the last filtered row still lands at the end of the full unpinned group', () => {
    const filtered = [ws('/u1'), ws('/u3')]
    const full = translateFilteredDropIndex(all, filtered, pinned, '/u1', filtered.length)
    expect(reorderPinned(all, pinned, '/u1', full)).toEqual(['/p1', '/p2', '/u2', '/u3', '/u1'])
  })

  it('an unfiltered list translates to the identity index, within the drag\'s own group', () => {
    for (let i = 2; i <= all.length; i++) {
      expect(translateFilteredDropIndex(all, all, pinned, '/u2', i)).toBe(i)
    }
    for (let i = 0; i <= pinned.size; i++) {
      expect(translateFilteredDropIndex(all, all, pinned, '/p1', i)).toBe(i)
    }
  })
})
