// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { DiffBody, diffBodyLines } from './DiffBody'

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

  it('omits the terminal newline without hiding blank lines inside a hunk', () => {
    expect(diffBodyLines('@@ -1 +1 @@\n context\n\n+new\n')).toEqual(['@@ -1 +1 @@', ' context', '', '+new'])
  })
})
