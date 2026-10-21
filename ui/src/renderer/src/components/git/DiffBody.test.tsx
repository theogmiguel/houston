// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { DiffBody, diffBodyLines, diffFindLines } from './DiffBody'
import { DiffFindContext, findInDiff, lineMarkKey, marksByLine } from './diffFind'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DiffBody', () => {
  it('pairs replacements and fills the missing old side in split layout', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    const props = { patch: '@@ -10,2 +20,3 @@\n-old\n+new\n+extra\n same', truncated: false, split: true }
    act(() => root.render(<DiffBody {...props} />))
    const pairs = host.querySelectorAll('[data-diff-pair]')
    expect(pairs).toHaveLength(3)
    expect(pairs[0].querySelector('[data-side="old"]')?.textContent).toContain('old')
    expect(pairs[0].querySelector('[data-side="new"]')?.textContent).toContain('new')
    expect(pairs[1].querySelector('[data-side="old"]')?.getAttribute('data-filler')).toBe('true')
    expect(pairs[1].querySelector('[data-side="new"]')?.getAttribute('data-line')).toBe('21')
    expect(pairs[2].querySelector('[data-side="old"]')?.getAttribute('data-line')).toBe('11')
    expect(pairs[2].querySelector('[data-side="new"]')?.getAttribute('data-line')).toBe('22')
    act(() => root.unmount())
  })

  it('starts at the first hunk and omits git file headers', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1234567..7654321 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<DiffBody patch={patch} truncated={false} />))
    expect(diffBodyLines(patch)).toEqual(['@@ -1 +1 @@', '-old', '+new'])
    expect(host.textContent).not.toContain('diff --git')
    expect(host.textContent).not.toContain('index 1234567')
    expect(host.textContent).not.toContain('--- a/src/a.ts')
    expect(host.textContent).not.toContain('+++ b/src/a.ts')
    expect(host.textContent).toContain('@@ -1 +1 @@')
    act(() => root.unmount())
  })

  it('keeps a patch that has no hunk header, such as a mode change or binary file', () => {
    const modeOnly = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755'].join('\n')
    expect(diffBodyLines(modeOnly)).toEqual(modeOnly.split('\n'))
    expect(diffBodyLines('+x')).toEqual(['+x'])
  })

  it('numbers the lines after a no-newline marker as if the marker were absent', () => {
    const patch = '@@ -1,2 +1,3 @@\n keep\n-last\n\\ No newline at end of file\n+last\n+added'
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<DiffBody patch={patch} truncated={false} />))
    const rows = Array.from(host.querySelectorAll('[data-kind]'))
    const marker = rows.find((row) => row.textContent?.includes('No newline'))
    expect(marker?.getAttribute('data-kind')).toBe('meta')
    expect(marker?.hasAttribute('data-old-line') || marker?.hasAttribute('data-new-line')).toBe(false)
    expect(rows.filter((row) => row.getAttribute('data-kind') === 'add').map((row) => row.getAttribute('data-new-line'))).toEqual(['2', '3'])
    act(() => root.unmount())
  })

  it('omits the terminal newline without hiding blank lines inside a hunk', () => {
    expect(diffBodyLines('@@ -1 +1 @@\n context\n\n+new\n')).toEqual(['@@ -1 +1 @@', ' context', '', '+new'])
  })

  it('highlights find matches at the same offsets it reports, marking a context line once in split', () => {
    const patch = '@@ -1,2 +1,2 @@\n same key\n-key = 1\n+key = 2'
    const sources = [{ key: 'f', lines: diffFindLines(patch), truncated: false }]
    expect(sources[0].lines).toEqual(['@@ -1,2 +1,2 @@', 'same key', 'key = 1', 'key = 2'])
    const { matches } = findInDiff(sources, 'key', false)
    const marks = marksByLine(matches, 0)
    const lookup = (key: string, line: number) => marks.get(lineMarkKey(key, line))
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<DiffFindContext.Provider value={lookup}><DiffBody patch={patch} truncated={false} findKey="f" /></DiffFindContext.Provider>))
    expect(Array.from(host.querySelectorAll('[data-diff-find-mark]')).map((mark) => mark.textContent)).toEqual(['key', 'key', 'key'])
    expect(host.querySelectorAll('[data-diff-find-active]')).toHaveLength(1)
    act(() => root.render(<DiffFindContext.Provider value={lookup}><DiffBody patch={patch} truncated={false} split findKey="f" /></DiffFindContext.Provider>))
    expect(host.querySelectorAll('[data-diff-find-mark]')).toHaveLength(4)
    expect(host.querySelector('[data-diff-find-active]')?.closest('[data-side]')?.getAttribute('data-side')).toBe('new')
    act(() => root.unmount())
  })

  it('highlights matches in the plain fallback for very long patches', () => {
    const patch = ['@@ -1,4001 +1,4001 @@', ...Array.from({ length: 4001 }, (_, i) => (i === 4000 ? '+needle' : ' line'))].join('\n')
    const sources = [{ key: 'f', lines: diffFindLines(patch), truncated: false }]
    const marks = marksByLine(findInDiff(sources, 'needle', false).matches, 0)
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<DiffFindContext.Provider value={(key, line) => marks.get(lineMarkKey(key, line))}><DiffBody patch={patch} truncated={false} findKey="f" /></DiffFindContext.Provider>))
    expect(host.querySelector('pre')?.textContent).toContain('+needle')
    expect(host.querySelector('[data-diff-find-active]')?.textContent).toBe('needle')
    act(() => root.unmount())
  })
})
