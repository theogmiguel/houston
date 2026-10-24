// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addGrid,
  flushLayoutSaves,
  gridStorageKey,
  leaf,
  loadLayout,
  onGridsSaved,
  removeGrid,
  saveLayout,
  savedGrids,
  setRatio,
  type LayoutNode
} from './tree'

const KEY = '/ws/drag::g-default'
const STORED = `tr-layout:${KEY}`

function row(...children: LayoutNode[]): LayoutNode {
  return { kind: 'split', dir: 'row', weights: children.map(() => 1 / children.length), children }
}

function layoutWrites(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([key]: unknown[]) => String(key).startsWith('tr-layout:')).length
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

describe('debounced layout saves', () => {
  let setItem: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    setItem = vi.spyOn(Storage.prototype, 'setItem')
  })

  afterEach(() => {
    flushLayoutSaves()
    setItem.mockRestore()
    vi.useRealTimers()
    setVisibility('visible')
    localStorage.clear()
  })

  it('writes a splitter drag once, 300 ms after its last frame, and notifies once', () => {
    let notified = 0
    const off = onGridsSaved(() => {
      notified += 1
    })
    let tree = row(leaf(1), leaf(2))
    for (let frame = 1; frame <= 60; frame++) {
      tree = setRatio(tree, [], 0, 0.5 + frame / 200)
      saveLayout(KEY, { tree, cols: 2 })
      vi.advanceTimersByTime(16)
    }
    expect(layoutWrites(setItem)).toBe(0)
    expect(notified).toBe(0)
    expect(loadLayout(KEY).tree).toEqual(tree)

    vi.advanceTimersByTime(299 - 16)
    expect(layoutWrites(setItem)).toBe(0)
    vi.advanceTimersByTime(1)
    expect(layoutWrites(setItem)).toBe(1)
    expect(notified).toBe(1)
    expect(JSON.parse(localStorage.getItem(STORED)!).tree).toEqual(tree)
    off()
  })

  it('writes a pending layout at once when the window is hidden', () => {
    const tree = row(leaf(1), leaf(2), leaf(3))
    saveLayout(KEY, { tree, cols: 3 })
    expect(localStorage.getItem(STORED)).toBeNull()

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(JSON.parse(localStorage.getItem(STORED)!)).toEqual({ tree, cols: 3 })
    vi.advanceTimersByTime(1000)
    expect(layoutWrites(setItem)).toBe(1)
  })

  it('writes a pending layout at once on pagehide', () => {
    const tree = leaf(4)
    saveLayout(KEY, { tree, cols: 1 })
    window.dispatchEvent(new Event('pagehide'))
    expect(JSON.parse(localStorage.getItem(STORED)!).tree).toEqual(tree)
  })

  it('keeps a pending layout when the window becomes visible', () => {
    saveLayout(KEY, { tree: leaf(5), cols: 1 })
    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(localStorage.getItem(STORED)).toBeNull()
  })

  it('lists a grid whose layout is not yet written', () => {
    const [grid] = addGrid('/ws/list', 'Main')
    saveLayout(gridStorageKey('/ws/list', grid.id), { tree: row(leaf(7), leaf(8)), cols: 2 })
    expect(savedGrids().find((g) => g.id === grid.id)?.sessions).toEqual([7, 8])
  })

  it('never writes back the layout of a grid removed before its save landed', () => {
    const grids = addGrid('/ws/remove', 'Second')
    const doomed = grids[grids.length - 1]
    const key = gridStorageKey('/ws/remove', doomed.id)
    saveLayout(key, { tree: leaf(9), cols: 1 })
    removeGrid('/ws/remove', doomed.id)
    vi.advanceTimersByTime(1000)
    expect(localStorage.getItem(`tr-layout:${key}`)).toBeNull()
    expect(loadLayout(key).tree).toBeNull()
  })
})
