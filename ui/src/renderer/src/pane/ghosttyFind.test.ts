import { describe, expect, it, vi } from 'vitest'
import {
  createGhosttyFinder,
  findBackward,
  findForward,
  type FindableSurface
} from './ghosttyFind'

const BUFFER = [
  'first line with needle',
  'second line',
  'third line with needle again',
  'fourth NEEDLE in caps',
  ''
]

const readRow = (y: number): string => BUFFER[y] ?? ''

describe('findForward', () => {
  it('finds the first match at or after the start position', () => {
    expect(findForward(readRow, BUFFER.length, 'needle', 0, 0)).toEqual({
      row: 0,
      startColumn: 16,
      endColumn: 21
    })
    expect(findForward(readRow, BUFFER.length, 'needle', 1, 0)).toEqual({
      row: 2,
      startColumn: 16,
      endColumn: 21
    })
  })

  it('matches case-insensitively, like the SearchAddon defaults it replaces', () => {
    expect(findForward(readRow, BUFFER.length, 'needle', 3, 0)?.row).toBe(3)
    expect(findForward(readRow, BUFFER.length, 'NeEdLe', 0, 0)?.row).toBe(0)
  })

  it('wraps past the end and can match earlier columns of the starting row', () => {
    const wrapped = findForward(readRow, BUFFER.length, 'first', 1, 0)
    expect(wrapped).toEqual({ row: 0, startColumn: 0, endColumn: 4 })
  })

  it('returns null for an absent needle, an empty needle, or an empty buffer', () => {
    expect(findForward(readRow, BUFFER.length, 'haystack', 0, 0)).toBeNull()
    expect(findForward(readRow, BUFFER.length, '', 0, 0)).toBeNull()
    expect(findForward(readRow, 0, 'needle', 0, 0)).toBeNull()
  })
})

describe('findBackward', () => {
  it('finds the last match at or before the start position', () => {
    expect(findBackward(readRow, BUFFER.length, 'needle', 4, Number.MAX_SAFE_INTEGER)?.row).toBe(3)
    expect(findBackward(readRow, BUFFER.length, 'needle', 2, Number.MAX_SAFE_INTEGER)?.row).toBe(2)
    expect(findBackward(readRow, BUFFER.length, 'needle', 1, Number.MAX_SAFE_INTEGER)?.row).toBe(0)
  })

  it('respects a column limit inside the starting row', () => {
    const row2 = BUFFER[2]
    expect(findBackward(readRow, BUFFER.length, 'needle', 2, row2.indexOf('needle') - 1)?.row).toBe(
      0
    )
  })
})

function surfaceStub(rows: string[]): {
  surface: FindableSurface
  selections: { start: { x: number; y: number }; end: { x: number; y: number } }[]
  revealed: number[]
} {
  const selections: { start: { x: number; y: number }; end: { x: number; y: number } }[] = []
  const revealed: number[] = []
  return {
    selections,
    revealed,
    surface: {
      cols: 80,
      bufferRowCount: () => rows.length,
      withScreenReader: (read) => read((y) => rows[y] ?? ''),
      selectScreenRange: (start, end) => {
        selections.push({ start, end })
      },
      revealScreenRow: (y) => {
        revealed.push(y)
      },
      clearSelection: vi.fn()
    }
  }
}

describe('createGhosttyFinder', () => {
  it('selects and reveals each match, stepping forward on repeated calls', () => {
    const { surface, selections, revealed } = surfaceStub(BUFFER)
    const finder = createGhosttyFinder(surface)

    expect(finder.findNext('needle')).toBe(true)
    expect(selections.at(-1)).toEqual({ start: { x: 16, y: 0 }, end: { x: 21, y: 0 } })
    expect(revealed.at(-1)).toBe(0)

    expect(finder.findNext('needle')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(2)

    expect(finder.findNext('needle')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(3)

    expect(finder.findNext('needle')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(0)
  })

  it('steps backward from the newest output first', () => {
    const { surface, selections } = surfaceStub(BUFFER)
    const finder = createGhosttyFinder(surface)
    expect(finder.findPrevious('needle')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(3)
    expect(finder.findPrevious('needle')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(2)
  })

  it('extends the match in place while the needle grows (incremental)', () => {
    const { surface, selections } = surfaceStub(['alpha beta', 'alphabet soup'])
    const finder = createGhosttyFinder(surface)

    finder.findNext('alpha', { incremental: true })
    expect(selections.at(-1)).toEqual({ start: { x: 0, y: 0 }, end: { x: 4, y: 0 } })
    finder.findNext('alpha ', { incremental: true })
    expect(selections.at(-1)).toEqual({ start: { x: 0, y: 0 }, end: { x: 5, y: 0 } })
  })

  it('clears the selection and reports failure for an empty needle', () => {
    const { surface, selections } = surfaceStub(BUFFER)
    const finder = createGhosttyFinder(surface)
    expect(finder.findNext('')).toBe(false)
    expect(selections).toHaveLength(0)
    expect(surface.clearSelection).toHaveBeenCalled()
  })

  it('reports failure without selecting anything when nothing matches', () => {
    const { surface, selections, revealed } = surfaceStub(BUFFER)
    const finder = createGhosttyFinder(surface)
    expect(finder.findNext('nothing-here')).toBe(false)
    expect(selections).toHaveLength(0)
    expect(revealed).toHaveLength(0)
  })

  it('restarts the sweep when the needle changes', () => {
    const { surface, selections } = surfaceStub(BUFFER)
    const finder = createGhosttyFinder(surface)
    finder.findNext('needle')
    finder.findNext('needle')
    expect(selections.at(-1)?.start.y).toBe(2)
    expect(finder.findNext('first')).toBe(true)
    expect(selections.at(-1)?.start.y).toBe(0)
  })
})
