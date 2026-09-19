import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCopyOutputDefault,
  lastOutputLines,
  setCopyOutputDefault,
  stripBoxGlyphs,
  type BufferLike,
  type BufferLineLike
} from './copyOutput'

function buffer(rows: Array<[string, boolean]>): BufferLike {
  const lines: BufferLineLike[] = rows.map(([text, isWrapped]) => ({
    isWrapped,
    translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/ +$/, '') : text)
  }))
  return { length: lines.length, getLine: (y) => lines[y] }
}

describe('lastOutputLines', () => {
  it('joins wrapped rows into one logical line', () => {
    const buf = buffer([
      ['first', false],
      ['a-very-long-com', false],
      ['mand-line-that-', true],
      ['wrapped', true],
      ['last', false]
    ])
    expect(lastOutputLines(buf, 'all')).toBe('first\na-very-long-command-line-that-wrapped\nlast')
  })

  it('keeps spaces at the wrap seam (no trim before a wrapped row)', () => {
    const buf = buffer([
      ['ends with spaces   ', false],
      ['then more', true]
    ])
    expect(lastOutputLines(buf, 'all')).toBe('ends with spaces   then more')
  })

  it('takes the last N logical lines, not rows', () => {
    const buf = buffer([
      ['one', false],
      ['two-a', false],
      ['two-b', true],
      ['three', false]
    ])
    expect(lastOutputLines(buf, 2)).toBe('two-atwo-b\nthree')
    expect(lastOutputLines(buf, 1)).toBe('three')
    expect(lastOutputLines(buf, 99)).toBe('one\ntwo-atwo-b\nthree')
  })

  it('drops trailing blank lines (the viewport tail) but keeps inner ones', () => {
    const buf = buffer([
      ['real output', false],
      ['', false],
      ['more', false],
      ['   ', false],
      ['', false]
    ])
    expect(lastOutputLines(buf, 'all')).toBe('real output\n\nmore')
  })

  it('returns an empty string for an all-blank buffer', () => {
    expect(lastOutputLines(buffer([['', false], ['  ', false]]), 'all')).toBe('')
  })
})

describe('stripBoxGlyphs', () => {
  it('strips a real-shaped Claude Code box: title, interior blank, indented body', () => {
    const box = [
      '╭────────────────────────────────────────────────────╮',
      '│ ✻ Welcome to Claude Code!                           │',
      '│                                                      │',
      '│   /help for help, /status for your current setup    │',
      '│                                                      │',
      '│   cwd: /home/dev/projects/houston       │',
      '╰────────────────────────────────────────────────────╯'
    ].join('\n')

    expect(stripBoxGlyphs(box)).toBe(
      [
        '✻ Welcome to Claude Code!',
        '',
        '  /help for help, /status for your current setup',
        '',
        '  cwd: /home/dev/projects/houston'
      ].join('\n')
    )
  })

  it('drops a border-only rule line entirely — no blank line left behind', () => {
    expect(stripBoxGlyphs('╭─────╮')).toBe('')
    expect(
      stripBoxGlyphs(['before', '├──────┤', 'after'].join('\n'))
    ).toBe('before\nafter')
  })

  it('leaves an interior box glyph exactly as it is — it is content, not framing', () => {
    expect(stripBoxGlyphs('Use the │ pipe below')).toBe('Use the │ pipe below')
    expect(stripBoxGlyphs('Total: 42│widgets shipped')).toBe('Total: 42│widgets shipped')
  })

  it('unwraps a titled top border, dropping the rule glyphs and keeping the title', () => {
    expect(stripBoxGlyphs('╭─ Settings ───────────────────╮')).toBe('Settings')
  })

  it('strips a one-sided wall (opener/closer scrolled out of a narrow pane) with no stray margin space', () => {
    expect(
      stripBoxGlyphs('│ some long content that got cut off because the terminal is narrow')
    ).toBe('some long content that got cut off because the terminal is narrow')
  })

  it('fully unwraps a box nested inside another box, not just the outer frame', () => {
    expect(
      stripBoxGlyphs('╭─inner─────────╮\n│ hi             │\n╰────────────────╯')
    ).toBe('inner\nhi')
  })

  it('drops a framed table divider row but keeps the interior │ column separators (edge-only rule)', () => {
    expect(stripBoxGlyphs('│ Name │ Age │\n├──────┼─────┤\n│ Jane │ 30  │')).toBe(
      'Name │ Age\nJane │ 30'
    )
  })

  it('leaves a diff/code-listing gutter byte-identical — its │ is interior, not an edge wall', () => {
    const gutter = '  1 │ function foo() {\n  2 │   return 1\n  3 │ }'
    expect(stripBoxGlyphs(gutter)).toBe(gutter)
  })

  it('returns a no-box input byte-identical, not just equal', () => {
    const plain = 'Line one\n  Line two with leading spaces\nLine three with trailing spaces   \n'
    expect(stripBoxGlyphs(plain)).toBe(plain)
    const noGlyph = 'kept as-is   '
    expect(stripBoxGlyphs(noGlyph)).toBe(noGlyph)
  })
})

describe('lastOutputLines box-glyph stripping', () => {
  function buffer(rows: Array<[string, boolean]>): BufferLike {
    const lines: BufferLineLike[] = rows.map(([text, isWrapped]) => ({
      isWrapped,
      translateToString: (trimRight?: boolean) => (trimRight ? text.replace(/ +$/, '') : text)
    }))
    return { length: lines.length, getLine: (y) => lines[y] }
  }

  it('defaults on: a boxed summary comes back stripped', () => {
    const buf = buffer([
      ['╭───────╮', false],
      ['│ hello │', false],
      ['╰───────╯', false]
    ])
    expect(lastOutputLines(buf, 'all')).toBe('hello')
  })

  it('stripBox=false keeps the box glyphs verbatim', () => {
    const buf = buffer([
      ['╭───────╮', false],
      ['│ hello │', false],
      ['╰───────╯', false]
    ])
    expect(lastOutputLines(buf, 'all', false)).toBe('╭───────╮\n│ hello │\n╰───────╯')
  })
})

describe('copy-output default persistence', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0
    } as unknown as Storage
  })

  it('defaults to 200 and round-trips a choice', () => {
    expect(getCopyOutputDefault()).toBe(200)
    setCopyOutputDefault(500)
    expect(getCopyOutputDefault()).toBe(500)
    setCopyOutputDefault('all')
    expect(getCopyOutputDefault()).toBe('all')
  })

  it('falls back to 200 on garbage stored values', () => {
    localStorage.setItem('tr-copy-output-lines', 'banana')
    expect(getCopyOutputDefault()).toBe(200)
    localStorage.setItem('tr-copy-output-lines', '250')
    expect(getCopyOutputDefault()).toBe(200)
  })
})
