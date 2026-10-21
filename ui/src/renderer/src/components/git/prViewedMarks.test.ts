// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPrViewedMarksForTests,
  markPrFileUnviewed,
  markPrFileViewed,
  patchHash,
  prViewedKey,
  prViewedMarks,
  viewedState
} from './prViewedMarks'

const KEY = prViewedKey('github.com', 'acme/houston', 412)

beforeEach(() => {
  localStorage.clear()
  clearPrViewedMarksForTests()
})

describe('patchHash', () => {
  it('is stable for the same text and 16 hex digits long', () => {
    expect(patchHash('@@ -1 +1 @@\n-old\n+new')).toMatch(/^[0-9a-f]{16}$/)
    expect(patchHash('@@ -1 +1 @@\n-old\n+new')).toBe(patchHash('@@ -1 +1 @@\n-old\n+new'))
  })

  it('differs when any line of the patch changes', () => {
    const before = patchHash('@@ -1 +1 @@\n-old\n+new')
    expect(patchHash('@@ -1 +1 @@\n-old\n+newer')).not.toBe(before)
    expect(patchHash('')).not.toBe(patchHash('\n'))
  })
})

describe('viewedState', () => {
  it('reads an absent mark as unviewed', () => {
    expect(viewedState(undefined, 'a1b2')).toBe('unviewed')
  })

  it('reads a matching mark as viewed', () => {
    expect(viewedState('a1b2c3d4e5f60718', 'a1b2c3d4e5f60718')).toBe('viewed')
  })

  it('reads a stale mark as changed, never viewed', () => {
    expect(viewedState('a1b2c3d4e5f60718', 'ffffffffffffffff')).toBe('changed')
  })
})

describe('prViewedKey', () => {
  it('names the host, repository and number, so forks never share marks', () => {
    expect(prViewedKey('github.com', 'acme/houston', 412)).toBe('github.com/acme/houston#412')
    expect(prViewedKey('github.com', 'fork/houston', 412)).not.toBe(KEY)
  })
})

describe('marks', () => {
  it('records and withdraws per-file hashes', () => {
    markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))
    expect(prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
    markPrFileViewed(KEY, 'docs/user/tasks.md', patchHash('docs'))
    markPrFileUnviewed(KEY, 'core/orchestrate.rs')
    expect(prViewedMarks(KEY)).toEqual({ 'docs/user/tasks.md': patchHash('docs') })
    markPrFileUnviewed(KEY, 'docs/user/tasks.md')
    expect(prViewedMarks(KEY)).toEqual({})
  })

  it('ignores a null key, so an unidentified PR still renders', () => {
    expect(() => markPrFileViewed(null, 'a', 'b')).not.toThrow()
    expect(prViewedMarks(null)).toEqual({})
  })

  it('keeps marks across a module reload, through storage', async () => {
    markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
  })

  it('evicts the oldest pull request past the cap', () => {
    for (let number = 0; number < 200; number += 1) markPrFileViewed(prViewedKey('github.com', 'acme/houston', number), 'a', patchHash(String(number)))
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 0))).toEqual({ a: patchHash('0') })
    markPrFileViewed(prViewedKey('github.com', 'acme/houston', 200), 'a', patchHash('200'))
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 0))).toEqual({})
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 1))).toEqual({ a: patchHash('1') })
    expect(prViewedMarks(prViewedKey('github.com', 'acme/houston', 200))).toEqual({ a: patchHash('200') })
  })

  it('survives storage that refuses both reads and writes, for the session', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.resetModules()
    try {
      const fresh = await import('./prViewedMarks')
      expect(() => fresh.markPrFileViewed(KEY, 'core/orchestrate.rs', patchHash('old'))).not.toThrow()
      expect(fresh.prViewedMarks(KEY)).toEqual({ 'core/orchestrate.rs': patchHash('old') })
    } finally {
      getItem.mockRestore()
      setItem.mockRestore()
    }
  })

  it('reads nothing out of corrupt storage', async () => {
    localStorage.setItem('tr-pr-viewed-marks', '{not json')
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(KEY)).toEqual({})
  })

  it('drops entries whose shapes storage cannot vouch for', async () => {
    localStorage.setItem('tr-pr-viewed-marks', JSON.stringify({ 'github.com/acme/houston#7': { at: 'tuesday', files: {} }, 'github.com/acme/houston#8': { at: 5, files: { a: 3 } }, 'github.com/acme/houston#9': { at: 5, files: { a: 'h1' } } }))
    vi.resetModules()
    const fresh = await import('./prViewedMarks')
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 7))).toEqual({})
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 8))).toEqual({})
    expect(fresh.prViewedMarks(prViewedKey('github.com', 'acme/houston', 9))).toEqual({ a: 'h1' })
  })
})
