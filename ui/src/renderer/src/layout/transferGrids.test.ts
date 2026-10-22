// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { collectTransferGrids, placeTransferGrids } from './transferGrids'
import { gridStorageKey, preorderSessions, saveLayout, type GridMeta, type LayoutNode } from './tree'

const SOURCE = '/home/a/project'
const TARGET = '/home/b/project'

function seed(): void {
  const grids: GridMeta[] = [
    { id: 'g-default', name: 'Main', nameSource: 'user', tags: [3] },
    { id: 'g2', name: 'Shells', nameSource: 'user', tags: [] }
  ]
  localStorage.setItem(`tr-grids:${SOURCE}`, JSON.stringify(grids))
  const main: LayoutNode = {
    kind: 'split',
    dir: 'row',
    weights: [0.6, 0.4],
    children: [
      { kind: 'leaf', session: 4, id: 'p4' },
      {
        kind: 'stack',
        id: 's1',
        activeIndex: 1,
        children: [
          { kind: 'leaf', session: 9, id: 'p9' },
          { kind: 'editor', id: 'e1', path: `${SOURCE}/src/lib.rs` },
          { kind: 'editor', id: 'e2', path: '/etc/hosts' }
        ]
      }
    ]
  }
  saveLayout(gridStorageKey(SOURCE, 'g-default'), { tree: main, cols: 2 })
  saveLayout(gridStorageKey(SOURCE, 'g2'), { tree: { kind: 'leaf', session: 12, id: 'p12' }, cols: 1 })
}

afterEach(() => localStorage.clear())

describe('workspace transfer grids', () => {
  it('remaps sessions and folders, drops what did not travel and keeps the target names unique', () => {
    seed()
    const blob = collectTransferGrids(SOURCE)
    const placed = placeTransferGrids(blob, SOURCE, TARGET, [{ from: 4, to: 101 }, { from: 9, to: 102 }], [
      { id: 'g-default', name: 'Main' }
    ])
    expect(placed.grids).toHaveLength(1)
    const [grid] = placed.grids
    expect(grid.name).toBe('Main (transferred)')
    expect(grid.id).not.toBe('g-default')
    expect(grid.tags).toEqual([])
    const [[key, layout]] = placed.layouts
    expect(key).toBe(gridStorageKey(TARGET, grid.id))
    expect(preorderSessions(layout.tree)).toEqual([101, 102])
    const stack = layout.tree?.kind === 'split' ? layout.tree.children[1] : null
    expect(stack?.kind).toBe('stack')
    if (stack?.kind !== 'stack') return
    expect(stack.children.map((child) => (child.kind === 'editor' ? child.path : child.kind))).toEqual([
      'leaf',
      `${TARGET}/src/lib.rs`
    ])
    expect(stack.activeIndex).toBe(1)
  })

  it('rebases files stored under the registered path when the file records the canonical one', () => {
    const registered = '/home/a/link-to-project'
    localStorage.setItem(`tr-grids:${registered}`, JSON.stringify([{ id: 'g', name: 'Main', nameSource: 'user', tags: [] }]))
    saveLayout(gridStorageKey(registered, 'g'), {
      tree: { kind: 'editor', id: 'e', path: `${registered}/src/lib.rs` },
      cols: 1
    })
    const placed = placeTransferGrids(collectTransferGrids(registered), SOURCE, TARGET, [], [])
    const tree = placed.layouts[0]?.[1].tree
    expect(tree?.kind === 'editor' ? tree.path : null).toBe(`${TARGET}/src/lib.rs`)
  })

  it('matches Windows paths whatever their letter case, separators or verbatim prefix', () => {
    const registered = 'c:/Dev/App'
    localStorage.setItem(`tr-grids:${registered}`, JSON.stringify([{ id: 'g', name: 'Main', nameSource: 'user', tags: [] }]))
    const tree: LayoutNode = {
      kind: 'stack',
      id: 's',
      activeIndex: 0,
      children: [
        { kind: 'editor', id: 'e1', path: 'C:\\dev\\app\\src\\main.rs' },
        { kind: 'files', id: 'f1', root: 'c:/Dev/App/docs' },
        { kind: 'editor', id: 'e2', path: 'C:\\dev\\application\\x.rs' }
      ]
    }
    saveLayout(gridStorageKey(registered, 'g'), { tree, cols: 1 })
    const placed = placeTransferGrids(collectTransferGrids(registered), '\\\\?\\C:\\dev\\app', 'D:\\work\\app', [], [])
    const placedTree = placed.layouts[0]?.[1].tree
    expect(placedTree?.kind).toBe('stack')
    if (placedTree?.kind !== 'stack') return
    expect(placedTree.children.map((child) => (child.kind === 'editor' ? child.path : child.kind === 'files' ? child.root : null))).toEqual([
      'D:\\work\\app\\src\\main.rs',
      'D:\\work\\app\\docs'
    ])
  })

  it('ignores a blob it cannot read', () => {
    expect(placeTransferGrids('not json', SOURCE, TARGET, [], [])).toEqual({ grids: [], layouts: [] })
    expect(placeTransferGrids('{"version":2}', SOURCE, TARGET, [], [])).toEqual({ grids: [], layouts: [] })
  })
})
