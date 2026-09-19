import { describe, expect, it } from 'vitest'
import { checkComplexity, perFile } from './check-complexity.mjs'

function diag(filename, complexity) {
  return {
    message: `function \`X\` has a complexity of ${complexity}. Maximum allowed is 1.`,
    code: 'eslint(complexity)',
    severity: 'error',
    filename
  }
}

const pin = (total, worst, over) => ({ total, worst, over })

describe('perFile', () => {
  it('sums every function, keeps the worst, and counts those over the ceiling', () => {
    expect(perFile([diag('a.tsx', 30), diag('a.tsx', 21), diag('a.tsx', 4)], 20)).toEqual({
      'a.tsx': { total: 55, worst: 30, over: 2 }
    })
  })

  it('counts a function exactly ON the ceiling as under it', () => {
    expect(perFile([diag('a.tsx', 20)], 20)).toEqual({ 'a.tsx': { total: 20, worst: 20, over: 0 } })
  })

  it('is empty for no diagnostics', () => {
    expect(perFile([], 20)).toEqual({})
  })

  it('refuses a message it cannot read a number out of', () => {
    expect(() => perFile([{ filename: 'a.tsx', message: 'something else entirely' }], 20)).toThrow(
      /no complexity number.*something else entirely/s
    )
  })
})

describe('checkComplexity', () => {
  const present = new Set(['a.tsx', 'b.tsx'])

  it('passes when every file sits exactly on its pin', () => {
    const actual = { 'a.tsx': { total: 55, worst: 30, over: 1 } }
    expect(checkComplexity(actual, { 'a.tsx': pin(55, 30, 1) }, present, 20)).toEqual([])
  })

  it('ignores an unpinned file that has nothing over the ceiling', () => {
    const actual = { 'b.tsx': { total: 12, worst: 6, over: 0 } }
    expect(checkComplexity(actual, {}, present, 20)).toEqual([])
  })

  it('fails an unpinned file that does have over-ceiling debt', () => {
    const actual = { 'b.tsx': { total: 23, worst: 23, over: 1 } }
    const out = checkComplexity(actual, {}, present, 20)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^b\.tsx .*allowance is 0/)
  })

  it('ALLOWS a risen total when worst and over hold — that is new code', () => {
    const actual = { 'a.tsx': { total: 90, worst: 30, over: 1 } }
    expect(checkComplexity(actual, { 'a.tsx': pin(55, 30, 1) }, present, 20)).toEqual([])
  })

  it('fails a risen worst, and a risen over-count, each by name', () => {
    const out = checkComplexity(
      { 'a.tsx': { total: 55, worst: 31, over: 2 } },
      { 'a.tsx': pin(55, 30, 1) },
      present,
      20
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/worst 30 → 31/)
    expect(out[0]).toMatch(/over 1 → 2/)
  })

  it('records, but cannot refuse, a score lowered by scope relabelling', () => {
    const relabelled = { 'a.tsx': { total: 111, worst: 17, over: 0 } }
    const out = checkComplexity(relabelled, { 'a.tsx': pin(121, 55, 1) }, present, 20)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/lower the pin/)
    expect(out[0]).toMatch(/worst 17\/over 0 \(total 111\)/)
    expect(out[0]).toMatch(/pin says worst 55\/over 1 \(total 121\)/)
  })

  it('fails an improvement, asking for the pin to be lowered', () => {
    const actual = { 'a.tsx': { total: 40, worst: 24, over: 1 } }
    const out = checkComplexity(actual, { 'a.tsx': pin(55, 30, 1) }, present, 20)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/now worst 24\/over 1 \(total 40\), pin says worst 30\/over 1 \(total 55\)/)
  })

  it('fails a pin on a file that is now clean, telling you to delete it', () => {
    const out = checkComplexity({}, { 'a.tsx': pin(55, 30, 1) }, present, 20)
    expect(out).toEqual([expect.stringMatching(/a\.tsx .* now clean — delete the entry/)])
  })

  it('distinguishes a pin on a deleted file from a pin on a cleaned one', () => {
    const out = checkComplexity({}, { 'gone.tsx': pin(55, 30, 1) }, present, 20)
    expect(out).toEqual([expect.stringMatching(/gone\.tsx .* no longer exists — delete the entry/)])
  })

  it('reports every violation, not just the first', () => {
    const actual = {
      'a.tsx': { total: 60, worst: 40, over: 2 },
      'b.tsx': { total: 21, worst: 21, over: 1 }
    }
    const out = checkComplexity(actual, { 'a.tsx': pin(55, 30, 1) }, present, 20)
    expect(out).toHaveLength(2)
  })
})
