// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentSearchResult } from '../../houston/bridge'
import type { KeymapOverrides } from '../../houston/client'
import { handleContentSearchShortcut } from '../../appSurfaceEvents'
import { ContentSearch, contentSearchNotice, highlightSegments } from './ContentSearch'

afterEach(() => {
  cleanup()
  search.mockReset()
})
const search = vi.hoisted(() => vi.fn())
vi.mock('../../houston/bridge', () => ({ searchFileContents: search }))

const result = (files: ContentSearchResult['files'], stoppedAt: ContentSearchResult['stoppedAt'] = null): ContentSearchResult => ({
  files,
  matchingLines: files.reduce((sum, file) => sum + file.matches.length, 0),
  scannedFiles: 10,
  skippedLarge: 0,
  skippedBinary: 0,
  stoppedAt,
})
const hit = (line: number, preview: string, from: number, to: number) => ({ line, column: from + 1, preview, ranges: [[from, to]] as [number, number][] })

describe('ContentSearch', () => {
  it('groups matches by file with counts and opens the active match at its line and column', async () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    search.mockResolvedValue(result([
      { path: 'src/a.ts', matches: [hit(3, 'const needle = 1', 6, 12), hit(9, 'needle()', 0, 6)] },
      { path: 'docs/b.md', matches: [hit(1, 'A needle here', 2, 8)] },
    ]))
    render(<ContentSearch root="/ws" workspaceName="ws" onOpen={onOpen} onClose={onClose} />)
    const input = screen.getByRole('combobox', { name: 'Search in files' })
    fireEvent.change(input, { target: { value: 'needle' } })
    const rows = await screen.findAllByRole('option')
    expect(search).toHaveBeenCalledWith('/ws', 'needle', { caseSensitive: false, wholeWord: false, regex: false })
    expect(rows).toHaveLength(3)
    expect(screen.getByText('src/a.ts').nextElementSibling?.textContent).toBe('2')
    expect(screen.getByText('docs/b.md').nextElementSibling?.textContent).toBe('1')
    expect([...rows[0].querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['needle'])
    expect(screen.getByText('3 lines in 2 files')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(rows[2].getAttribute('aria-selected')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[2].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('docs/b.md', 1, 3)
    fireEvent.click(rows[1])
    expect(onOpen).toHaveBeenLastCalledWith('src/a.ts', 9, 1)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('sends the case, whole-word and regex toggles and keeps focus in the field', async () => {
    search.mockResolvedValue(result([]))
    render(<ContentSearch root="/ws" workspaceName="ws" onOpen={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Search in files' })
    fireEvent.change(input, { target: { value: 'x' } })
    const matchCase = screen.getByRole('button', { name: 'Match case (Alt+C)' })
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    fireEvent(matchCase, press)
    expect(press.defaultPrevented).toBe(true)
    fireEvent.click(matchCase)
    fireEvent.keyDown(input, { key: 'w', altKey: true })
    fireEvent.keyDown(input, { key: 'r', altKey: true })
    expect(matchCase.getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('/ws', 'x', { caseSensitive: true, wholeWord: true, regex: true }))
    expect(await screen.findByText('No matches.')).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })

  it('shows only the newest query when an older search resolves later', async () => {
    const pending: Array<(value: ContentSearchResult) => void> = []
    search.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    render(<ContentSearch root="/ws" workspaceName="ws" onOpen={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Search in files' })
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    fireEvent.change(input, { target: { value: 'new' } })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    pending[1](result([{ path: 'new.ts', matches: [hit(1, 'new', 0, 3)] }]))
    await screen.findByText('new.ts')
    pending[0](result([{ path: 'old.ts', matches: [hit(1, 'old', 0, 3)] }]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('old.ts')).toBeNull()
  })

  it('marks the field invalid and shows the search error', async () => {
    search.mockRejectedValue('fs_search_contents: "a(" is not a valid regular expression: unclosed group')
    render(<ContentSearch root="/ws" workspaceName="ws" onOpen={vi.fn()} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Search in files' })
    fireEvent.change(input, { target: { value: 'a(' } })
    expect((await screen.findByRole('alert')).textContent).toContain('"a(" is not a valid regular expression')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('names each limit the search stopped at', () => {
    expect(contentSearchNotice(result([], { kind: 'matchingLines', limit: 1000, actual: 1001 }))).toBe(
      'Showing the first 1000 matching lines. Refine your search.',
    )
    expect(contentSearchNotice(result([], { kind: 'scannedFiles', limit: 20000, actual: 54000 }))).toBe(
      'Searched 20000 of 54000 files, the file limit. Refine your search.',
    )
    expect(contentSearchNotice({ ...result([], { kind: 'milliseconds', limit: 5000, actual: 5003 }), skippedLarge: 2 })).toBe(
      'Stopped after 5003 ms, past the 5000 ms limit, with 10 files searched. Refine your search. Skipped 2 files over 1 MB.',
    )
    expect(contentSearchNotice({ ...result([]), skippedLarge: 1 })).toBe('Skipped 1 file over 1 MB.')
    expect(contentSearchNotice(result([]))).toBeNull()
  })

  it('splits a preview into highlighted segments by UTF-16 range', () => {
    expect(highlightSegments('a 😀 needle b needle', [[5, 11], [14, 20]])).toEqual([
      { text: 'a 😀 ', hit: false },
      { text: 'needle', hit: true },
      { text: ' b ', hit: false },
      { text: 'needle', hit: true },
    ])
  })
})

describe('handleContentSearchShortcut', () => {
  const overrides: KeymapOverrides = { bindings: {}, shortcuts_enabled: true }
  const chord = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true, cancelable: true, ...init })

  it('opens on Mod+Shift+F outside a terminal and leaves a focused terminal its key', () => {
    const open = vi.fn()
    const outside = chord({})
    expect(handleContentSearchShortcut(outside, overrides, '/ws', open)).toBe(true)
    expect(outside.defaultPrevented).toBe(true)
    const terminal = document.createElement('textarea')
    terminal.setAttribute('aria-label', 'Terminal input')
    document.body.append(terminal)
    const inside = chord({ bubbles: true })
    terminal.dispatchEvent(inside)
    expect(handleContentSearchShortcut(inside, overrides, '/ws', open)).toBe(false)
    expect(inside.defaultPrevented).toBe(false)
    terminal.remove()
    expect(handleContentSearchShortcut(chord({}), overrides, 'all', open)).toBe(false)
    expect(handleContentSearchShortcut(chord({}), { ...overrides, shortcuts_enabled: false }, '/ws', open)).toBe(false)
    expect(open).toHaveBeenCalledOnce()
  })

  it('follows a rebound chord', () => {
    const open = vi.fn()
    const rebound: KeymapOverrides = {
      bindings: { 'search-file-contents': { code: 'KeyG', ctrl: true, alt: true, shift: false, meta: false } },
      shortcuts_enabled: true,
    }
    expect(handleContentSearchShortcut(chord({}), rebound, '/ws', open)).toBe(false)
    expect(handleContentSearchShortcut(chord({ key: 'g', code: 'KeyG', shiftKey: false, altKey: true }), rebound, '/ws', open)).toBe(true)
    expect(open).toHaveBeenCalledOnce()
  })
})
