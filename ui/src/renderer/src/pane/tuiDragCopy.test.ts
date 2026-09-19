import { describe, expect, it } from 'vitest'
import {
  extractDragRangeText,
  pixelToCell,
  TUI_DRAG_EMPTY_HINT,
  type DragBufferLike,
  type DragBufferLineLike
} from './tuiDragCopy'

function buffer(rows: string[]): DragBufferLike {
  const lines: DragBufferLineLike[] = rows.map((text) => ({
    translateToString: (trimRight?: boolean, startColumn?: number, endColumn?: number) => {
      const sliced = text.slice(startColumn ?? 0, endColumn ?? text.length)
      return trimRight ? sliced.replace(/ +$/, '') : sliced
    }
  }))
  return { getLine: (y) => lines[y] }
}

describe('pixelToCell', () => {
  const rect = { left: 100, top: 50, width: 800, height: 480 }

  it('maps a pixel inside a cell to that cell', () => {
    expect(pixelToCell(80, 24, rect, 105, 55)).toEqual({ col: 0, row: 0 })
    expect(pixelToCell(80, 24, rect, 155, 95)).toEqual({ col: 5, row: 2 })
  })

  it('clamps a pixel before the host origin to cell (0, 0)', () => {
    expect(pixelToCell(80, 24, rect, 0, 0)).toEqual({ col: 0, row: 0 })
  })

  it('clamps a pixel past the last column/row to the last cell', () => {
    expect(pixelToCell(80, 24, rect, 10_000, 10_000)).toEqual({ col: 79, row: 23 })
  })

  it('never returns a negative index for a degenerate 0-size grid', () => {
    expect(pixelToCell(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 5, 5)).toEqual({
      col: 0,
      row: 0
    })
  })
})

describe('extractDragRangeText', () => {
  it('reconstructs a multi-line range clipped to the start/end columns', () => {
    const buf = buffer(['0123456789', 'abcdefghij', 'ABCDEFGHIJ'])
    const text = extractDragRangeText(buf, { row: 0, col: 5 }, { row: 2, col: 2 }, false)
    expect(text).toBe('56789\nabcdefghij\nABC')
  })

  it('is order-independent — end-before-start drag direction gives the same result', () => {
    const buf = buffer(['0123456789', 'abcdefghij', 'ABCDEFGHIJ'])
    const forward = extractDragRangeText(buf, { row: 0, col: 5 }, { row: 2, col: 2 }, false)
    const backward = extractDragRangeText(buf, { row: 2, col: 2 }, { row: 0, col: 5 }, false)
    expect(backward).toBe(forward)
  })

  it('handles a single-row range, swapping reversed columns on the same row', () => {
    const buf = buffer(['0123456789'])
    expect(extractDragRangeText(buf, { row: 0, col: 2 }, { row: 0, col: 6 }, false)).toBe('23456')
    expect(extractDragRangeText(buf, { row: 0, col: 6 }, { row: 0, col: 2 }, false)).toBe('23456')
  })

  it('trims trailing blanks per line via trimRight', () => {
    const buf = buffer(['hi        ', 'there   '])
    expect(extractDragRangeText(buf, { row: 0, col: 0 }, { row: 1, col: 7 }, false)).toBe(
      'hi\nthere'
    )
  })

  it('strips box glyphs when the setting is on', () => {
    const buf = buffer(['│ boxed │'])
    expect(extractDragRangeText(buf, { row: 0, col: 0 }, { row: 0, col: 8 }, true)).toBe('boxed')
  })

  it('leaves box glyphs alone when the setting is off', () => {
    const buf = buffer(['│ boxed │'])
    expect(extractDragRangeText(buf, { row: 0, col: 0 }, { row: 0, col: 8 }, false)).toBe(
      '│ boxed │'
    )
  })

  it('returns an empty string for a no-movement drag over a blank cell', () => {
    const buf = buffer(['   '])
    expect(extractDragRangeText(buf, { row: 0, col: 1 }, { row: 0, col: 1 }, false).trim()).toBe(
      ''
    )
  })
})

describe('TUI_DRAG_EMPTY_HINT', () => {
  it('is the donor hint verbatim (non-Mac variant)', () => {
    expect(TUI_DRAG_EMPTY_HINT).toBe('No selection — hold Shift and drag')
  })
})
