import { describe, expect, it } from 'vitest'
import { findCountLabel, findInDiff, lineMarkKey, marksByLine, MAX_DIFF_FIND_MATCHES, stepMatch } from './diffFind'

const sources = [
  { key: 'a.ts', lines: ['const Value = value', 'return value'], truncated: false },
  { key: 'b.ts', lines: ['no match here', 'VALUE (value)'], truncated: false }
]

describe('findInDiff', () => {
  it('finds every match in source and line order, ignoring case by default', () => {
    const { matches, capped } = findInDiff(sources, 'value', false)
    expect(capped).toBe(false)
    expect(matches).toEqual([
      { key: 'a.ts', line: 0, start: 6, end: 11 },
      { key: 'a.ts', line: 0, start: 14, end: 19 },
      { key: 'a.ts', line: 1, start: 7, end: 12 },
      { key: 'b.ts', line: 1, start: 0, end: 5 },
      { key: 'b.ts', line: 1, start: 7, end: 12 }
    ])
  })

  it('matches case exactly when asked', () => {
    expect(findInDiff(sources, 'Value', true).matches).toEqual([{ key: 'a.ts', line: 0, start: 6, end: 11 }])
  })

  it('treats the query as literal text', () => {
    expect(findInDiff(sources, '(value)', false).matches).toEqual([{ key: 'b.ts', line: 1, start: 6, end: 13 }])
    expect(findInDiff(sources, '.*', false).matches).toEqual([])
  })

  it('returns nothing for an empty query', () => {
    expect(findInDiff(sources, '', false)).toEqual({ matches: [], capped: false })
  })

  it('stops at the match cap and says so', () => {
    const wide = [{ key: 'big', lines: ['a'.repeat(MAX_DIFF_FIND_MATCHES + 10)], truncated: false }]
    const result = findInDiff(wide, 'a', false)
    expect(result.matches).toHaveLength(MAX_DIFF_FIND_MATCHES)
    expect(result.capped).toBe(true)
    expect(findCountLabel(result, 0, 'a')).toBe(`1/${MAX_DIFF_FIND_MATCHES}+`)
  })
})

describe('stepMatch', () => {
  it('wraps in both directions', () => {
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(0)
  })
})

describe('marksByLine', () => {
  it('groups ranges per line and marks the active one', () => {
    const { matches } = findInDiff(sources, 'value', false)
    const marks = marksByLine(matches, 1)
    expect(marks.get(lineMarkKey('a.ts', 0))).toEqual({ ranges: [[6, 11], [14, 19]], active: 1 })
    expect(marks.get(lineMarkKey('b.ts', 1))).toEqual({ ranges: [[0, 5], [7, 12]], active: null })
    expect(marks.has(lineMarkKey('b.ts', 0))).toBe(false)
  })
})

describe('findCountLabel', () => {
  it('names the empty result and the position', () => {
    expect(findCountLabel({ matches: [], capped: false }, 0, '')).toBe('')
    expect(findCountLabel({ matches: [], capped: false }, 0, 'x')).toBe('No results')
    expect(findCountLabel(findInDiff(sources, 'value', false), 3, 'value')).toBe('4/5')
  })
})
