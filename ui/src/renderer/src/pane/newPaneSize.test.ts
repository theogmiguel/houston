// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { leaf, stackPane, type LayoutNode } from '../layout/tree'
import { newPaneRects, newPaneSizes, registerTerminalSizer, slotBox } from './newPaneSize'

const row = (...children: LayoutNode[]): LayoutNode => ({
  kind: 'split',
  dir: 'row',
  children,
  weights: children.map(() => 100 / children.length)
})

describe('newPaneRects', () => {
  it('fills the grid when the grid is empty', () => {
    expect(newPaneRects(null, null)).toEqual([{ x: 0, y: 0, w: 100, h: 100 }])
  })

  it('takes half of the anchor for a split', () => {
    const tree = row(leaf(1), leaf(2))
    expect(newPaneRects(tree, { anchor: 2, side: 'right' })).toEqual([{ x: 75, y: 0, w: 25, h: 100 }])
    expect(newPaneRects(tree, { anchor: 1, side: 'bottom' })).toEqual([{ x: 0, y: 50, w: 50, h: 50 }])
  })

  it('appends to the root, once per pane launched together', () => {
    const rects = newPaneRects(leaf(1), null, 2)
    expect(rects.map((r) => Math.round(r.w))).toEqual([33, 33])
    expect(rects.map((r) => Math.round(r.x))).toEqual([33, 67])
  })

  it('appends when the anchor sits in a stack, where a split inserts nothing', () => {
    const tree = row(leaf(1), stackPane([leaf(2), leaf(3)]))
    const [rect] = newPaneRects(tree, { anchor: 3, side: 'right' })
    expect(Math.round(rect.x)).toBe(67)
  })
})

describe('slotBox', () => {
  it('insets a full gutter on grid edges and half a gutter between slots', () => {
    expect(slotBox({ x: 0, y: 0, w: 50, h: 100 }, { width: 1000, height: 600 }, 8)).toEqual({
      width: 500 - 8 - 4,
      height: 600 - 16
    })
  })
})

describe('newPaneSizes', () => {
  const CELL = { width: 8, height: 16 }
  const PADDING = 4
  let cleanup: Array<() => void> = []
  afterEach(() => {
    for (const fn of cleanup) fn()
    cleanup = []
    document.body.replaceChildren()
  })

  // A grid of one terminal pane: 1000x600, gutter 8, 30x40 of header and border chrome.
  const mountGrid = (session: number): void => {
    const grid = document.createElement('div')
    grid.style.setProperty('--pane-gutter', '8px')
    grid.getBoundingClientRect = () => ({ width: 1000, height: 600 }) as DOMRect
    const slot = document.createElement('div')
    slot.className = 'pane-slot'
    slot.getBoundingClientRect = () => ({ width: 1000 - 16, height: 600 - 16 }) as DOMRect
    const host = document.createElement('div')
    slot.append(host)
    grid.append(slot)
    document.body.append(grid)
    cleanup.push(
      registerTerminalSizer(session, {
        host,
        mountBox: () => ({ width: 1000 - 16 - 30, height: 600 - 16 - 40 }),
        gridForBox: (width, height) => ({
          cols: Math.floor((width - PADDING * 2) / CELL.width),
          rows: Math.floor((height - PADDING * 2) / CELL.height)
        })
      })
    )
  }

  it('sizes a split pane to the grid its own fit will choose', () => {
    mountGrid(1)
    const [size] = newPaneSizes({ current: leaf(1), target: leaf(1), placement: { anchor: 1, side: 'right' } })
    // Slot: 500 - 8 - 4 = 488 wide, minus 30 chrome = 458; 600 - 16 - 40 = 544 high.
    expect(size).toEqual({ cols: Math.floor((458 - 8) / 8), rows: Math.floor((544 - 8) / 16) })
  })

  it('sizes a pane for a new grid from the grid on screen', () => {
    mountGrid(1)
    const [size] = newPaneSizes({ current: leaf(1), target: null })
    expect(size).toEqual({ cols: Math.floor((954 - 8) / 8), rows: Math.floor((544 - 8) / 16) })
  })

  it('gives no size when no terminal on screen can be measured', () => {
    expect(newPaneSizes({ current: leaf(1), target: leaf(1) })).toEqual([null])
  })
})
