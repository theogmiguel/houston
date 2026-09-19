import { describe, expect, it } from 'vitest'
import { findUrls, rangesOverlap, joinWrappedLine, mapJoinedOffset, type WrappedLineSource } from './webLinks'

describe('findUrls', () => {
  it('matches a plain URL', () => {
    const matches = findUrls('visit https://example.com/path for docs')
    expect(matches.map((m) => m.url)).toEqual(['https://example.com/path'])
  })

  it('trims a trailing period at the end of a sentence', () => {
    const matches = findUrls('see https://example.com/foo.')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://example.com/foo')
  })

  it('trims a wrapping closing paren with no matching opener', () => {
    const matches = findUrls('(https://example.com/foo)')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://example.com/foo')
  })

  it('keeps balanced parens that are genuinely part of the URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(disambiguation)'
    const matches = findUrls(`see ${url} for more`)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe(url)
  })

  it('matches the inner URL when wrapped in angle brackets', () => {
    const matches = findUrls('<https://example.com/foo>')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://example.com/foo')
  })

  it('matches the inner URL when wrapped in quotes', () => {
    const matches = findUrls(`"https://example.com/foo"`)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://example.com/foo')
  })

  it('matches two URLs on one line', () => {
    const matches = findUrls('https://a.example.com and https://b.example.com')
    expect(matches.map((m) => m.url)).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('does not match a non-http scheme', () => {
    const matches = findUrls('run javascript:alert(1) or file:///etc/passwd')
    expect(matches).toEqual([])
  })

  it('does not match bare www. or scheme-relative //host', () => {
    const matches = findUrls('go to www.example.com or //example.com/x')
    expect(matches).toEqual([])
  })

  it('does not match across a newline', () => {
    const matches = findUrls('https://example.com/foo\nbar')
    expect(matches[0].url).toBe('https://example.com/foo')
  })

  it('matches a URL adjacent to a token FILE_TOKEN_RE would also match', () => {
    const matches = findUrls('fetch https://example.com/foo.js now')
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe('https://example.com/foo.js')
  })

  it('rejects a URL that trims down to a bare scheme with no host', () => {
    expect(findUrls('see http://. more')).toEqual([])
    expect(findUrls('http://,,,,')).toEqual([])
    expect(findUrls('http://...')).toEqual([])
  })

  it('rejects a URL whose authority contains userinfo (user@host confusion)', () => {
    expect(findUrls('see http://google.com@evil.com/phish here')).toEqual([])
  })

  it('still matches a normal URL with no userinfo', () => {
    const matches = findUrls('see https://example.com/phish here')
    expect(matches.map((m) => m.url)).toEqual(['https://example.com/phish'])
  })
})

describe('joinWrappedLine / mapJoinedOffset (wrapped-URL stitching)', () => {
  function makeBuffer(rows: Array<{ text: string; isWrapped: boolean }>): WrappedLineSource {
    return {
      getLine(y: number) {
        const r = rows[y]
        if (!r) return undefined
        return {
          isWrapped: r.isWrapped,
          translateToString: (trimRight?: boolean) => (trimRight ? r.text.replace(/\s+$/, '') : r.text)
        }
      }
    }
  }

  it('stitches a URL wrapped across three rows into one matchable line, mapping back to the right rows', () => {
    const url = 'https://example.com/foo/bar/baz/qux/really/long/path/segment'
    const width = 12
    const rowsText: string[] = []
    for (let i = 0; i < url.length; i += width) rowsText.push(url.slice(i, i + width))
    expect(rowsText.length).toBeGreaterThanOrEqual(3)

    const buffer = makeBuffer(rowsText.map((text, i) => ({ text, isWrapped: i > 0 })))
    const joined = joinWrappedLine(buffer, 0)
    expect(joined.text).toBe(url)

    const matches = findUrls(joined.text)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe(url)

    const start = mapJoinedOffset(joined, matches[0].start)
    const end = mapJoinedOffset(joined, matches[0].end - 1)
    expect(start).toEqual({ row: 0, col: 0 })
    expect(end.row).toBe(rowsText.length - 1)
    expect(end.col).toBe(rowsText[rowsText.length - 1].length - 1)
  })

  it('does not pull a following non-wrapped row into a URL that ends exactly at a row boundary', () => {
    const width = 10
    const scheme = 'https://'
    const host = 'example.com/'
    const path = 'p'.repeat(width * 2 - scheme.length - host.length)
    const url = scheme + host + path
    expect(url.length).toBe(width * 2)

    const buffer = makeBuffer([
      { text: url.slice(0, width), isWrapped: false },
      { text: url.slice(width, width * 2), isWrapped: true },
      { text: 'unrelated!', isWrapped: false }
    ])

    const joined = joinWrappedLine(buffer, 0)
    expect(joined.text).toBe(url)
    expect(joined.rows).toEqual([0, 1])

    const matches = findUrls(joined.text)
    expect(matches).toHaveLength(1)
    const end = mapJoinedOffset(joined, matches[0].end - 1)
    expect(end.row).toBe(1)
    expect(end.col).toBe(width - 1)
  })

  it('walks isWrapped backward too, so querying a continuation row still finds the start of the logical line', () => {
    const width = 8
    const url = 'https://a.example.com/x'
    const rowsText: string[] = []
    for (let i = 0; i < url.length; i += width) rowsText.push(url.slice(i, i + width))
    const buffer = makeBuffer(rowsText.map((text, i) => ({ text, isWrapped: i > 0 })))

    const joinedFromLastRow = joinWrappedLine(buffer, rowsText.length - 1)
    expect(joinedFromLastRow.text).toBe(url)
    expect(joinedFromLastRow.rows[0]).toBe(0)
  })

  it('clamps the backward walk at row 0 when the logical line\'s first row is not retained', () => {
    const width = 8
    const url = 'https://a.example.com/x'
    const rowsText: string[] = []
    for (let i = 0; i < url.length; i += width) rowsText.push(url.slice(i, i + width))
    const buffer = makeBuffer(rowsText.map((text) => ({ text, isWrapped: true })))

    const joined = joinWrappedLine(buffer, rowsText.length - 1)
    expect(joined.text).toBe(url)
    expect(joined.rows[0]).toBe(0)

    const matches = findUrls(joined.text)
    expect(matches).toHaveLength(1)
    expect(matches[0].url).toBe(url)
  })

  it('preserves trailing spaces on non-final wrapped rows so offsets stay correct and no URL is fabricated across the gap', () => {
    const buffer = makeBuffer([
      { text: 'https://example.com/a   ', isWrapped: false },
      { text: 'https://example.com/b', isWrapped: true }
    ])

    const joined = joinWrappedLine(buffer, 0)
    expect(joined.text).toBe('https://example.com/a   https://example.com/b')
    expect(joined.rowStarts).toEqual([0, 'https://example.com/a   '.length])

    const matches = findUrls(joined.text)
    expect(matches.map((m) => m.url)).toEqual(['https://example.com/a', 'https://example.com/b'])

    const secondStart = mapJoinedOffset(joined, matches[1].start)
    expect(secondStart).toEqual({ row: 1, col: 0 })
  })
})

describe('rangesOverlap', () => {
  it('detects overlapping half-open ranges', () => {
    expect(rangesOverlap(0, 5, 3, 8)).toBe(true)
    expect(rangesOverlap(0, 5, 5, 8)).toBe(false)
    expect(rangesOverlap(0, 5, 6, 8)).toBe(false)
  })
})
