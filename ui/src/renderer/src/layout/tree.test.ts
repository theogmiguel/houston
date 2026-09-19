import { describe, expect, it } from 'vitest'
import {
  addGrid,
  appendToRoot,
  clampSplitRatio,
  computeRects,
  MIN_PANE_PX,
  DEFAULT_GRID_ID,
  evenGrid,
  findEditorByPath,
  findPane,
  findStackContaining,
  containsPaneKind,
  removePaneKind,
  migrateSavedGitLeaves,
  gridStorageKey,
  insertBeside,
  insertPaneAt,
  isAutoNameable,
  autoNameGrid,
  leaf as mintLeaf,
  loadGrids,
  loadLayout,
  moveLeaf,
  paneId,
  preorderLeaves,
  preorderNonSessionPanes,
  preorderSessions,
  prune,
  regrid,
  removeGrid,
  renameGrid,
  reviveLeaf,
  setActiveStackTab,
  sessionPaneIds,
  skillsPane,
  stackPane,
  quadrant,
  removeLeaf,
  saveLayout,
  setRatio,
  stackWith,
  swapLeaf,
  syncTree,
  unstack,
  updateBrowserUrl,
  type BrowserNode,
  type EditorNode,
  type LayoutNode,
  type LeafNode,
  type SplitNode
} from './tree'

const leaf = (session: number, id = `p${session}`): LeafNode => mintLeaf(session, id)

function stripPaneIds(node: LayoutNode | null): unknown {
  if (!node) return null
  if (node.kind === 'split') return { ...node, children: node.children.map(stripPaneIds) }
  if (node.kind !== 'leaf') return node
  const { id: _id, ...rest } = node
  return rest
}

const browser = (id: string, url = 'http://localhost:5173'): BrowserNode => ({
  kind: 'browser',
  id,
  url
})

const editor = (id: string, path = '/proj/src/main.ts'): EditorNode => ({
  kind: 'editor',
  id,
  path
})

if (typeof globalThis.localStorage === 'undefined') {
  const data = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length(): number {
      return data.size
    }
  } as Storage
}

function row(...children: LayoutNode[]): SplitNode {
  return {
    kind: 'split',
    dir: 'row',
    children,
    weights: children.map(() => 100 / children.length)
  }
}

describe('prune', () => {
  it('drops dead sessions, collapses single-child splits, keeps browser leaves', () => {
    const tree = row(leaf(1), leaf(2), browser('b1'))
    const pruned = prune(tree, new Set([2]))!
    expect(preorderLeaves(pruned)).toEqual([2, 'b1'])

    const collapsed = prune(row(leaf(1), leaf(2)), new Set([2]))
    expect(collapsed).toEqual(leaf(2))
  })
})

describe('appendToRoot', () => {
  it('preserves user-dragged sibling ratios; newcomer gets 1/n', () => {
    const custom: SplitNode = { ...row(leaf(1), leaf(2)), weights: [70, 30] }
    const next = appendToRoot(custom, leaf(3)) as SplitNode
    expect(next.weights[2]).toBeCloseTo(100 / 3)
    expect(next.weights[0] / next.weights[1]).toBeCloseTo(70 / 30)
  })
})

describe('setRatio', () => {
  it('redistributes between the two neighbours only', () => {
    const tree = row(leaf(1), leaf(2), leaf(3))
    const next = setRatio(tree, [], 0, 0.25) as SplitNode
    const pairSum = 200 / 3
    expect(next.weights[0]).toBeCloseTo(0.25 * pairSum)
    expect(next.weights[1]).toBeCloseTo(0.75 * pairSum)
    expect(next.weights[2]).toBeCloseTo(100 / 3)
  })

  it('ignores stale out-of-bounds indices instead of injecting NaN', () => {
    const tree = row(leaf(1), leaf(2))
    const next = setRatio(tree, [], 1, 0.5) as SplitNode
    expect(next.weights).toEqual([50, 50])
    const bogusPath = setRatio(tree, [7], 0, 0.5)
    expect(bogusPath).toEqual(tree)
  })
})

describe('moveLeaf', () => {
  it('is a no-op when the dragged pane was pruned mid-drag', () => {
    const tree = row(leaf(2), leaf(3))
    expect(moveLeaf(tree, 1, 3, 'right')).toEqual(tree)
  })

  it('moves a browser pane with its url intact', () => {
    const tree = row(leaf(1), leaf(2), browser('b1', 'http://localhost:8123'))
    const next = moveLeaf(tree, 'b1', 1, 'left')
    expect(preorderLeaves(next)).toEqual(['b1', 1, 2])
    const moved = preorderLeaves(next)[0]
    expect(moved).toBe('b1')
    expect(JSON.stringify(next)).toContain('http://localhost:8123')
  })
})

describe('swapLeaf', () => {
  it('exchanges two leaves in differently-weighted slots, weights untouched', () => {
    const tree: SplitNode = { ...row(leaf(1), leaf(2)), weights: [70, 30] }
    const originalWeights = [...tree.weights]
    const next = swapLeaf(tree, 1, 2) as SplitNode
    expect(preorderLeaves(next)).toEqual([2, 1])
    expect(next.weights).toEqual(originalWeights)
  })

  it('swaps across different depths (nested split <-> root-level leaf)', () => {
    const tree = row(row(leaf(1), leaf(2)), leaf(3))
    const next = swapLeaf(tree, 2, 3)!
    expect(preorderLeaves(next)).toEqual([1, 3, 2])
  })

  it('swaps a terminal leaf with a browser or editor leaf, preserving url/path', () => {
    const tree = row(leaf(1), browser('b1', 'http://localhost:8123'), editor('e1', '/proj/a.ts'))
    const next = swapLeaf(tree, 1, 'b1')!
    expect(preorderLeaves(next)).toEqual(['b1', 1, 'e1'])
    expect(JSON.stringify(next)).toContain('http://localhost:8123')

    const next2 = swapLeaf(next, 1, 'e1')!
    expect(preorderLeaves(next2)).toEqual(['b1', 'e1', 1])
    expect(JSON.stringify(next2)).toContain('/proj/a.ts')
  })

  it('is a no-op on self-drop', () => {
    const tree = row(leaf(1), leaf(2))
    expect(swapLeaf(tree, 1, 1)).toBe(tree)
  })

  it('is a no-op when a key is absent from the tree', () => {
    const tree = row(leaf(1), leaf(2))
    expect(swapLeaf(tree, 1, 99)).toBe(tree)
  })

  it('is a no-op on a null tree', () => {
    expect(swapLeaf(null, 1, 2)).toBeNull()
  })
})

describe('quadrant', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect

  it('returns center inside the 25% margin from every edge', () => {
    expect(quadrant(rect, 50, 50)).toBe('center')
    expect(quadrant(rect, 25, 25)).toBe('center')
    expect(quadrant(rect, 75, 75)).toBe('center')
  })

  it('returns the nearest edge outside the centre region', () => {
    expect(quadrant(rect, 24, 50)).toBe('left')
    expect(quadrant(rect, 76, 50)).toBe('right')
    expect(quadrant(rect, 50, 24)).toBe('top')
    expect(quadrant(rect, 50, 76)).toBe('bottom')
  })
})

describe('insertBeside / removeLeaf', () => {
  it('splits 50/50 on the requested side and collapses on removal', () => {
    const tree = insertBeside(leaf(1), 1, leaf(2), 'bottom') as SplitNode
    expect(tree.dir).toBe('col')
    expect(tree.weights).toEqual([50, 50])
    expect(removeLeaf(tree, 2)).toEqual(leaf(1))
  })
})

describe('syncTree', () => {
  it('builds an even grid when there is no tree to reconcile', () => {
    const t = syncTree(null, [1, 2, 3, 4], 2)!
    const { leaves } = computeRects(t)
    expect(leaves).toHaveLength(4)
    for (const { rect } of leaves) {
      expect(rect.w).toBeCloseTo(50)
      expect(rect.h).toBeCloseTo(50)
    }
  })

  it('prunes dead + appends unknown sessions', () => {
    const tree = row(leaf(1), leaf(2))
    const next = syncTree(tree, [2, 9], 2)!
    expect(preorderSessions(next)).toEqual([2, 9])
  })

  it('keeps browser leaves across syncs', () => {
    const tree = row(leaf(1), browser('b1'))
    const next = syncTree(tree, [1], 2)!
    expect(preorderLeaves(next)).toEqual([1, 'b1'])
  })
})

describe('updateBrowserUrl', () => {
  it('updates only the matching browser leaf', () => {
    const tree = row(browser('b1', 'http://localhost:1111'), browser('b2', 'http://localhost:2222'))
    const next = updateBrowserUrl(tree, 'b2', 'http://localhost:9999') as SplitNode
    expect((next.children[0] as BrowserNode).url).toBe('http://localhost:1111')
    expect((next.children[1] as BrowserNode).url).toBe('http://localhost:9999')
  })
})

describe('editor leaves (batch D)', () => {
  it('survive prune alongside dead sessions', () => {
    const tree = row(leaf(1), leaf(2), editor('e1'))
    const pruned = prune(tree, new Set([2]))!
    expect(preorderLeaves(pruned)).toEqual([2, 'e1'])
  })

  it('are skipped by preorderSessions (no 1-9 shortcut)', () => {
    const tree = row(leaf(1), editor('e1'), leaf(2))
    expect(preorderSessions(tree)).toEqual([1, 2])
  })

  it('survive syncTree', () => {
    const tree = row(leaf(1), editor('e1'))
    const resynced = syncTree(tree, [1, 9], 2)!
    expect(preorderLeaves(resynced)).toEqual([1, 'e1', 9])
  })

  it('insertBeside/removeLeaf treat editor leaves like any other pane', () => {
    const tree = insertBeside(leaf(1), 1, editor('e1'), 'right') as SplitNode
    expect(preorderLeaves(tree)).toEqual([1, 'e1'])
    expect(removeLeaf(tree, 'e1')).toEqual(leaf(1))
  })

  it('findEditorByPath locates the leaf for a path, or null if absent', () => {
    const tree = row(leaf(1), editor('e1', '/proj/a.ts'), editor('e2', '/proj/b.ts'))
    expect(findEditorByPath(tree, '/proj/b.ts')).toEqual(editor('e2', '/proj/b.ts'))
    expect(findEditorByPath(tree, '/proj/missing.ts')).toBeNull()
  })

  it('round-trips through saveLayout/loadLayout', () => {
    const key = `test-editor-roundtrip-${Date.now()}`
    const tree = row(leaf(1), editor('e1', '/proj/a.ts'))
    saveLayout(key, { tree, cols: 2 })
    const loaded = loadLayout(key)
    expect(loaded.tree).toEqual(tree)
    localStorage.removeItem(`tr-layout:${key}`)
  })
})

describe('browser panes in the grid (M8)', () => {
  it('insertPaneAt puts the new pane beside its anchor', () => {
    const tree = row(leaf(1), leaf(2))
    const next = insertPaneAt(tree, browser('b1', ''), 2) as SplitNode
    expect(preorderLeaves(next)).toEqual([1, 2, 'b1'])
    const slot = next.children[1] as SplitNode
    expect(slot.kind).toBe('split')
    expect(slot.children).toEqual([leaf(2), browser('b1', '')])
    expect(slot.weights).toEqual([50, 50])
  })

  it('insertPaneAt appends to the root when the anchor died before the click landed', () => {
    const tree = row(leaf(1), leaf(2))
    const next = insertPaneAt(tree, browser('b1', ''), 99)
    expect(preorderLeaves(next)).toEqual([1, 2, 'b1'])
    expect((next as SplitNode).children[2]).toEqual(browser('b1', ''))
  })

  it('insertPaneAt makes the pane the whole tree in an empty workspace', () => {
    expect(insertPaneAt(null, browser('b1', ''), null)).toEqual(browser('b1', ''))
  })

  it('a fresh pane carries an empty url, which survives the tree unchanged', () => {
    const tree = insertPaneAt(null, browser('b1', ''), null)
    const key = `test-browser-fresh-${Date.now()}`
    saveLayout(key, { tree, cols: 2 })
    expect(loadLayout(key).tree).toEqual(browser('b1', ''))
    localStorage.removeItem(`tr-layout:${key}`)
  })

  it('closing the pane removes it and collapses the split it was in', () => {
    const tree = row(leaf(1), browser('b1', 'https://example.test/'))
    expect(removeLeaf(tree, 'b1')).toEqual(leaf(1))
  })

  it('closing the last pane leaves an empty workspace rather than a husk', () => {
    expect(removeLeaf(browser('b1', ''), 'b1')).toBeNull()
  })

  it('round-trips a navigated pane through saveLayout/loadLayout', () => {
    const key = `test-browser-roundtrip-${Date.now()}`
    const tree = insertPaneAt(row(leaf(1)), browser('b1', 'https://example.test/'), 1)
    saveLayout(key, { tree, cols: 2 })
    const loaded = loadLayout(key)
    expect(loaded.tree).toEqual(tree)
    localStorage.removeItem(`tr-layout:${key}`)
  })

  it('survives a sync against the live session set (it is not a session)', () => {
    const tree = row(leaf(1), browser('b1', 'https://example.test/'))
    const synced = syncTree(tree, [1], 2)!
    expect(preorderLeaves(synced)).toEqual([1, 'b1'])
  })
})

describe('regrid keeps the panes no session list can rebuild', () => {
  it('repositions terminals and carries browser/editor leaves across, ids intact', () => {
    const tree = row(leaf(1), browser('b1', 'https://example.test/'), editor('e1', '/proj/a.ts'))
    const next = regrid(tree, [1, 2], 2)!
    expect(preorderLeaves(next)).toEqual([1, 2, 'b1', 'e1'])
    const panes = preorderNonSessionPanes(next)
    expect(panes).toEqual([browser('b1', 'https://example.test/'), editor('e1', '/proj/a.ts')])
  })

  it('makes the kept pane the whole tree when no sessions are left', () => {
    expect(regrid(row(leaf(1), browser('b1', '')), [], 2)).toEqual(browser('b1', ''))
  })

  it('survives the syncTree path that used to lose them', () => {
    const tree = row(leaf(1), browser('b1', 'https://example.test/'))
    const synced = syncTree(tree, [1, 2], 2)!
    expect(preorderLeaves(synced)).toEqual([1, 'b1', 2])
  })

  it('is a plain even grid when there is nothing to keep', () => {
    expect(stripPaneIds(regrid(row(leaf(1), leaf(2)), [1, 2, 3], 3))).toEqual(
      stripPaneIds(evenGrid([1, 2, 3], 3))
    )
  })
})

describe('evenGrid', () => {
  it('chunks rows by column count', () => {
    const t = evenGrid([1, 2, 3, 4, 5], 2)!
    expect(preorderSessions(t)).toEqual([1, 2, 3, 4, 5])
    const { leaves } = computeRects(t)
    expect(leaves).toHaveLength(5)
  })
})

describe('clampSplitRatio', () => {
  it('keeps both panes at or above MIN_PANE_PX', () => {
    expect(clampSplitRatio(-1, 1200)).toBeCloseTo(MIN_PANE_PX / 1200)
    expect(clampSplitRatio(0, 1200)).toBeCloseTo(MIN_PANE_PX / 1200)
    expect(clampSplitRatio(2, 1200)).toBeCloseTo(1 - MIN_PANE_PX / 1200)
    expect(clampSplitRatio(0.5, 1200)).toBeCloseTo(0.5)
  })

  it('scales the local floor with the pair it is applied to, not the container', () => {
    expect(clampSplitRatio(0, 560)).toBeCloseTo(0.25)
    expect(clampSplitRatio(1, 560)).toBeCloseTo(0.75)
    expect(clampSplitRatio(0, 1400)).toBeCloseTo(0.1)
  })

  it('pins to 0.5 once the pair is too narrow to give both panes the floor', () => {
    expect(clampSplitRatio(0.9, 2 * MIN_PANE_PX)).toBeCloseTo(0.5)
    expect(clampSplitRatio(0.1, 200)).toBeCloseTo(0.5)
    expect(clampSplitRatio(0.9, 40)).toBeCloseTo(0.5)
  })

  it('treats a non-positive span as degenerate and pins to 0.5', () => {
    expect(clampSplitRatio(0.9, 0)).toBe(0.5)
    expect(clampSplitRatio(0.9, -5)).toBe(0.5)
  })
})

describe('durable pane identity (07-bridge R1, 2026-08-19)', () => {
  it('mints a distinct id per pane and keeps it across a save/load roundtrip', () => {
    const tree = row(mintLeaf(1), mintLeaf(2))
    const ids = sessionPaneIds(tree)
    expect(ids.get(1)).not.toBe(ids.get(2))

    saveLayout('/ws/identity', { tree, cols: 2 })
    const back = loadLayout('/ws/identity')
    expect(sessionPaneIds(back.tree)).toEqual(ids)
  })

  it('mints ids for a layout persisted before panes had one, keeping the grid', () => {
    localStorage.setItem(
      'tr-layout:/ws/legacy',
      JSON.stringify({
        cols: 2,
        tree: {
          kind: 'split',
          dir: 'row',
          weights: [60, 40],
          children: [
            { kind: 'leaf', session: 7 },
            { kind: 'leaf', session: 8 }
          ]
        }
      })
    )
    const loaded = loadLayout('/ws/legacy')
    expect(preorderSessions(loaded.tree)).toEqual([7, 8])
    expect((loaded.tree as SplitNode).weights).toEqual([60, 40])
    const ids = sessionPaneIds(loaded.tree)
    expect(ids.get(7)).toMatch(/^p\d+-\d+$/)
    expect(ids.get(7)).not.toBe(ids.get(8))
  })

  it('carries a pane id through a density regrid instead of minting a new one', () => {
    const before = row(mintLeaf(1), mintLeaf(2))
    const kept = sessionPaneIds(before)
    const after = regrid(before, [1, 2, 3], 3)
    expect(sessionPaneIds(after).get(1)).toBe(kept.get(1))
    expect(sessionPaneIds(after).get(2)).toBe(kept.get(2))
    expect(sessionPaneIds(after).get(3)).not.toBe(kept.get(1))
  })

  it('survives the same reconcile the panes themselves survive', () => {
    const before = row(mintLeaf(1), browser('b1'))
    const kept = sessionPaneIds(before)
    const synced = syncTree(before, [1, 2], 2)
    expect(sessionPaneIds(synced).get(1)).toBe(kept.get(1))
  })

  it('reviveLeaf moves a resumed session into the pane it was resumed from', () => {
    const before: SplitNode = { ...row(mintLeaf(1), mintLeaf(2)), weights: [70, 30] }
    const pane = sessionPaneIds(before).get(1)!
    const after = reviveLeaf(before, pane, 9) as SplitNode

    expect(preorderSessions(after)).toEqual([9, 2])
    expect(sessionPaneIds(after).get(9)).toBe(pane)
    expect(after.weights).toEqual([70, 30])
    expect(preorderSessions(prune(after, new Set([9, 2])))).toEqual([9, 2])
  })

  it('reviveLeaf reports a miss rather than guessing at a pane it cannot find', () => {
    const tree = row(mintLeaf(1), mintLeaf(2))
    expect(reviveLeaf(tree, 'p-never-existed', 9)).toBeNull()
    expect(reviveLeaf(null, 'p1', 9)).toBeNull()
  })
})

describe('skills panes survive the grid as non-session panes', () => {
  it('mints a skills pane and carries it across a regrid', () => {
    const s = skillsPane('s1')
    expect(s).toEqual({ kind: 'skills', id: 's1' })
    expect(paneId(s)).toBe('s1')

    const tree = row(mintLeaf(1), s)
    const after = regrid(tree, [1, 2], 2)
    expect(preorderNonSessionPanes(after)).toEqual(
      expect.arrayContaining([{ kind: 'skills', id: 's1' }])
    )
  })

  it('round-trips through saveLayout/loadLayout', () => {
    const tree = row(mintLeaf(1), skillsPane('s1'))
    saveLayout('/ws/skills', { tree, cols: 2 })
    const loaded = loadLayout('/ws/skills')
    expect(preorderNonSessionPanes(loaded.tree)).toEqual(
      expect.arrayContaining([{ kind: 'skills', id: 's1' }])
    )
  })
})

describe('the legacy git leaf migrates out of saved grids', () => {
  const GIT = { kind: 'git', id: 'g1' } as const

  it('removes the git leaf and nothing else, collapsing a two-child split', () => {
    const tree = row(mintLeaf(1, 'p1'), GIT)
    expect(removePaneKind(tree, 'git')).toEqual({ kind: 'leaf', session: 1, id: 'p1' })
    expect(containsPaneKind(tree, 'git')).toBe(true)
    expect(containsPaneKind(row(mintLeaf(1, 'p1'), skillsPane('s1')), 'git')).toBe(false)
  })

  it('keeps terminals, editors and browsers, renormalizing the kept weights', () => {
    const tree: LayoutNode = {
      kind: 'split',
      dir: 'row',
      weights: [60, 30, 10],
      children: [mintLeaf(1), { kind: 'editor', id: 'e1', path: '/p/a.ts' }, GIT]
    }
    const next = removePaneKind(tree, 'git') as Extract<LayoutNode, { kind: 'split' }>
    expect(next.children).toHaveLength(2)
    expect(next.weights).toEqual([expect.closeTo(66.66, 1), expect.closeTo(33.33, 1)])
    expect(preorderLeaves(next)).toEqual([1, 'e1'])
  })

  it('pulls a git tab out of a stack without dropping the terminal beside it', () => {
    const tree = stackPane([mintLeaf(1, 'p1'), GIT], 1)
    const next = removePaneKind(tree, 'git')
    expect(next).toEqual({ kind: 'leaf', session: 1, id: 'p1' })
  })

  it('loadLayout strips a legacy git leaf so it can never render in the grid', () => {
    localStorage.setItem(
      'tr-layout:/ws/legacy-git',
      JSON.stringify({
        cols: 2,
        tree: row(mintLeaf(1), GIT, skillsPane('s1'))
      })
    )
    const loaded = loadLayout('/ws/legacy-git')
    expect(preorderLeaves(loaded.tree)).toEqual([1, 's1'])
    expect(containsPaneKind(loaded.tree, 'git')).toBe(false)
  })

  it('migrateSavedGitLeaves rewrites every grid, reports each workspace once, and is idempotent', () => {
    localStorage.clear()
    localStorage.setItem(
      'tr-layout:/ws/a::g-default',
      JSON.stringify({ cols: 2, tree: row(mintLeaf(1), GIT) })
    )
    localStorage.setItem(
      'tr-layout:/ws/a::g-two',
      JSON.stringify({ cols: 2, tree: row(GIT, skillsPane('s1')) })
    )
    localStorage.setItem(
      'tr-layout:/ws/b::g-default',
      JSON.stringify({ cols: 2, tree: row(mintLeaf(2), mintLeaf(3)) })
    )
    expect(migrateSavedGitLeaves().sort()).toEqual(['/ws/a'])
    const a = JSON.parse(localStorage.getItem('tr-layout:/ws/a::g-default')!)
    expect(a.tree).toEqual({ kind: 'leaf', session: 1, id: expect.any(String) })
    expect(JSON.parse(localStorage.getItem('tr-layout:/ws/a::g-two')!).tree).toEqual({
      kind: 'skills',
      id: 's1'
    })
    expect(migrateSavedGitLeaves()).toEqual([])
  })
})

describe('an old persisted tree must not crash the app (step 04 hazard 1)', () => {
  it('loads a pre-step-04 tree — no git/skills nodes ever existed, only leaf/browser/editor', () => {
    localStorage.setItem(
      'tr-layout:/ws/pre-step04',
      JSON.stringify({
        cols: 2,
        tree: {
          kind: 'split',
          dir: 'row',
          weights: [50, 30, 20],
          children: [
            { kind: 'leaf', session: 3 },
            { kind: 'browser', id: 'b-old', url: 'https://example.test' },
            { kind: 'editor', id: 'e-old', path: '/proj/README.md' }
          ]
        }
      })
    )
    const loaded = loadLayout('/ws/pre-step04')
    expect(preorderSessions(loaded.tree)).toEqual([3])
    expect(preorderNonSessionPanes(loaded.tree)).toEqual([
      { kind: 'browser', id: 'b-old', url: 'https://example.test' },
      { kind: 'editor', id: 'e-old', path: '/proj/README.md' }
    ])
    const ids = sessionPaneIds(loaded.tree)
    expect(ids.get(3)).toMatch(/^p\d+-\d+$/)
  })

  it('resets to a fresh layout on an unrecognised node kind, rather than crashing', () => {
    localStorage.setItem(
      'tr-layout:/ws/corrupt',
      JSON.stringify({
        cols: 2,
        tree: { kind: 'review', id: 'r1' }
      })
    )
    const loaded = loadLayout('/ws/corrupt')
    expect(loaded).toEqual({ tree: null, cols: 2 })
  })
})

describe('grids (step 05 hazard 1: the storage re-key must not lose a layout)', () => {
  it('loads a pre-grid workspace into a single default grid, tree byte-identical', () => {
    const raw = JSON.stringify({
      cols: 2,
      tree: {
        kind: 'split',
        dir: 'row',
        weights: [50, 50],
        children: [{ kind: 'leaf', session: 3, id: 'p3' }, { kind: 'browser', id: 'b1', url: 'https://example.test' }]
      }
    })
    localStorage.setItem('tr-layout:/ws/pre-grid', raw)
    const grids = loadGrids('/ws/pre-grid')
    expect(grids).toEqual([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }])
    expect(localStorage.getItem('tr-layout:' + gridStorageKey('/ws/pre-grid', DEFAULT_GRID_ID))).toBe(raw)
    expect(localStorage.getItem('tr-layout:/ws/pre-grid')).toBe(raw)
    const loaded = loadLayout(gridStorageKey('/ws/pre-grid', DEFAULT_GRID_ID))
    expect(preorderSessions(loaded.tree)).toEqual([3])
  })

  it('an old layout whose leaves lack an id still loads through the migrated key', () => {
    localStorage.setItem(
      'tr-layout:/ws/pre-grid-no-ids',
      JSON.stringify({ cols: 2, tree: { kind: 'leaf', session: 7 } })
    )
    const grids = loadGrids('/ws/pre-grid-no-ids')
    expect(grids).toEqual([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }])
    const loaded = loadLayout(gridStorageKey('/ws/pre-grid-no-ids', DEFAULT_GRID_ID))
    expect(preorderSessions(loaded.tree)).toEqual([7])
  })

  it('a malformed legacy value does not crash migration — starts with one empty default grid', () => {
    localStorage.setItem('tr-layout:/ws/pre-grid-garbage', '{not json')
    const grids = loadGrids('/ws/pre-grid-garbage')
    expect(grids).toEqual([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }])
    const loaded = loadLayout(gridStorageKey('/ws/pre-grid-garbage', DEFAULT_GRID_ID))
    expect(loaded).toEqual({ tree: null, cols: 2 })
  })

  it('a brand-new workspace (no legacy key at all) gets one empty default grid', () => {
    const grids = loadGrids('/ws/brand-new')
    expect(grids).toEqual([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }])
    expect(localStorage.getItem(gridStorageKey('/ws/brand-new', DEFAULT_GRID_ID))).toBeNull()
  })

  it('migration runs at most once per workspace — idempotent on a second read', () => {
    localStorage.setItem(
      'tr-layout:/ws/idempotent',
      JSON.stringify({ cols: 2, tree: { kind: 'leaf', session: 1 } })
    )
    loadGrids('/ws/idempotent')
    addGrid('/ws/idempotent', 'Second')
    const grids = loadGrids('/ws/idempotent')
    expect(grids.map((g) => g.name)).toEqual(['Grid 1', 'Second'])
  })

  it('addGrid/renameGrid/removeGrid — never drops the last grid', () => {
    const [g1] = loadGrids('/ws/crud')
    const afterAdd = addGrid('/ws/crud', 'Second grid')
    expect(afterAdd).toHaveLength(2)
    const g2 = afterAdd[1]
    const renamed = renameGrid('/ws/crud', g2.id, 'Renamed')
    expect(renamed.find((g) => g.id === g2.id)?.name).toBe('Renamed')

    saveLayout(gridStorageKey('/ws/crud', g2.id), { tree: { kind: 'leaf', session: 9, id: 'p9' }, cols: 2 })
    const afterRemove = removeGrid('/ws/crud', g2.id)
    expect(afterRemove).toEqual([g1])
    expect(localStorage.getItem(gridStorageKey('/ws/crud', g2.id))).toBeNull()

    const stillOne = removeGrid('/ws/crud', g1.id)
    expect(stillOne).toEqual([g1])
  })
})

describe('grid auto-naming (the tab-naming rule)', () => {
  it('a freshly minted grid is auto-nameable and starts unnamed', () => {
    const [, g2] = addGrid('/ws/auto-new', 'Untitled')
    expect(isAutoNameable(g2)).toBe(true)
  })

  it('a legacy grid with no `named` field, named "Grid N", is still auto-nameable', () => {
    expect(isAutoNameable({ id: 'g-x', name: 'Grid 1' })).toBe(true)
    expect(isAutoNameable({ id: 'g-x', name: 'Grid 12' })).toBe(true)
  })

  it('a legacy grid with no `named` field but a non-default name is NOT auto-nameable', () => {
    expect(isAutoNameable({ id: 'g-x', name: 'review' })).toBe(false)
  })

  it('autoNameGrid applies the name and locks the grid against further auto-naming', () => {
    const grids = addGrid('/ws/auto-apply', 'Untitled')
    const g = grids[grids.length - 1]
    const after = autoNameGrid('/ws/auto-apply', g.id, 'Terminal')
    const updated = after.find((x) => x.id === g.id)!
    expect(updated.name).toBe('Terminal')
    expect(isAutoNameable(updated)).toBe(false)

    const again = autoNameGrid('/ws/auto-apply', g.id, 'Claude Code')
    expect(again.find((x) => x.id === g.id)?.name).toBe('Terminal')
  })

  it('renameGrid (a user rename) locks the grid against auto-naming too', () => {
    const grids = addGrid('/ws/auto-user-rename', 'Untitled')
    const g = grids[grids.length - 1]
    renameGrid('/ws/auto-user-rename', g.id, 'my review')
    const after = autoNameGrid('/ws/auto-user-rename', g.id, 'Claude Code')
    expect(after.find((x) => x.id === g.id)?.name).toBe('my review')
  })
})

describe('tab stacks (step 05, second half)', () => {
  it('stackWith wraps two bare panes into a 2-tab stack', () => {
    const tree = row(leaf(1), leaf(2))
    const stacked = stackWith(tree, 1, 2)
    expect(preorderLeaves(stacked)).toEqual([1, 2])
    const found = findStackContaining(stacked, 1)
    expect(found).not.toBeNull()
    expect(found!.children).toHaveLength(2)
    expect(found!.activeIndex).toBe(0)
  })

  it('stackWith appends to an existing stack, and refuses past the cap', () => {
    let tree: LayoutNode = row(leaf(1), leaf(2), leaf(3), leaf(4), leaf(5))
    tree = stackWith(tree, 1, 2)
    tree = stackWith(tree, 1, 3)
    tree = stackWith(tree, 1, 4)
    const full = findStackContaining(tree, 1)!
    expect(full.children).toHaveLength(4)
    const attempted = stackWith(tree, 1, 5)
    expect(attempted).toBe(tree)
    expect(findStackContaining(attempted, 1)!.children).toHaveLength(4)
  })

  it('stackWith is a no-op for identical panes or panes already stacked together', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    expect(stackWith(tree, 1, 1)).toBe(tree)
    expect(stackWith(tree, 1, 2)).toBe(tree)
  })

  it('unstack pulls a tab out, collapsing a 2-tab stack back to a bare pane', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    const after = unstack(tree, 2)
    expect(findStackContaining(after, 1)).toBeNull()
    expect(preorderLeaves(after).sort()).toEqual([1, 2])
  })

  it('unstack on a 3+ tab stack keeps the stack, minus that tab', () => {
    let tree: LayoutNode = row(leaf(1), leaf(2), leaf(3))
    tree = stackWith(tree, 1, 2)
    tree = stackWith(tree, 1, 3)
    const after = unstack(tree, 2)
    const stack = findStackContaining(after, 1)!
    expect(stack.children).toHaveLength(2)
    expect(preorderLeaves(after).sort()).toEqual([1, 2, 3])
  })

  it('unstack is a no-op when the pane is not stacked', () => {
    const tree = row(leaf(1), leaf(2))
    expect(unstack(tree, 1)).toBe(tree)
  })

  it('setActiveStackTab switches the displayed tab', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    const stack = findStackContaining(tree, 1)!
    const after = setActiveStackTab(tree, stack.id, 2)
    expect(findStackContaining(after, 1)!.activeIndex).toBe(1)
    expect(setActiveStackTab(tree, stack.id, 999)).toBe(tree)
  })

  it('a dead session inside a stack is pruned; the stack survives with its sibling', () => {
    const tree = stackWith(row(leaf(1), leaf(2), browser('b1')), 1, 2)
    const pruned = prune(tree, new Set([2]))!
    expect(preorderLeaves(pruned).sort()).toEqual([2, 'b1'])
    expect(findStackContaining(pruned, 2)).toBeNull()
  })

  it('removeLeaf on a stacked pane collapses correctly (closing a tab)', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    const after = removeLeaf(tree, 1)
    expect(preorderLeaves(after!)).toEqual([2])
  })

  it('findPane never returns a bare StackNode — only the pane it names', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    const stack = findStackContaining(tree, 1)!
    expect(findPane(tree, stack.id)).toBeNull()
    expect(findPane(tree, 1)).toEqual(leaf(1))
  })

  it('a density reset (regrid) dissolves a stack but keeps every pane (D37 applied to stacks)', () => {
    let tree: LayoutNode = row(leaf(1), leaf(2), browser('b1'))
    tree = stackWith(tree, 1, 2)
    const after = regrid(tree, [1, 2], 2)!
    expect(findStackContaining(after, 1)).toBeNull()
    expect(preorderSessions(after).sort()).toEqual([1, 2])
    expect(preorderNonSessionPanes(after)).toEqual([{ kind: 'browser', id: 'b1', url: 'http://localhost:5173' }])
  })

  it('updateBrowserUrl reaches a browser leaf stacked behind another tab', () => {
    const tree = stackWith(row(browser('b1'), leaf(1)), 'b1', 1)
    const after = updateBrowserUrl(tree, 'b1', 'https://new.example')
    const stack = findStackContaining(after, 1)!
    const b = stack.children.find((c) => c.kind === 'browser')
    expect(b).toEqual({ kind: 'browser', id: 'b1', url: 'https://new.example' })
  })

  it('round-trips a stack through saveLayout/loadLayout, including a leaf missing no id (stacks are step-05-only, always minted)', () => {
    const tree = stackWith(row(leaf(1), leaf(2)), 1, 2)
    saveLayout('/ws/stack-roundtrip', { tree, cols: 2 })
    const loaded = loadLayout('/ws/stack-roundtrip')
    expect(preorderLeaves(loaded.tree)).toEqual([1, 2])
  })

  it('rejects a corrupt persisted stack (bad activeIndex, too many tabs) rather than crashing', () => {
    localStorage.setItem(
      'tr-layout:/ws/stack-corrupt',
      JSON.stringify({
        cols: 2,
        tree: {
          kind: 'stack',
          id: 's1',
          activeIndex: 5,
          children: [{ kind: 'leaf', session: 1, id: 'p1' }]
        }
      })
    )
    expect(loadLayout('/ws/stack-corrupt')).toEqual({ tree: null, cols: 2 })
  })
})
