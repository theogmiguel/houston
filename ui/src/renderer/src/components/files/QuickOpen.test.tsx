// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileSearchResult } from '../../houston/bridge'
import { filesQuickOpenShortcut, rankQuickOpenResults, QuickOpen } from './QuickOpen'

afterEach(() => {
  cleanup()
  search.mockReset()
})
const item = (path: string, name: string, nameIndices: number[]): FileSearchResult => ({
  path,
  name,
  isDir: false,
  nameIndices,
  pathIndices: [],
})
const search = vi.hoisted(() => vi.fn())
vi.mock('../../houston/bridge', () => ({ searchFilePaths: search }))

describe('QuickOpen', () => {
  it('ranks filename matches before path-only matches', () => {
    const results = [item('docs/code.ts', 'code.ts', []), item('src/Code.ts', 'Code.ts', [0, 1, 2, 3])]
    expect(rankQuickOpenResults('code', results).map((result) => result.path)).toEqual(['src/Code.ts', 'docs/code.ts'])
  })

  it('opens the top ranked result with Enter and closes with Escape', async () => {
    const onOpen = vi.fn()
    const onClose = vi.fn()
    search.mockResolvedValue({ items: [item('src/a.ts', 'a.ts', [0])], total: 1, truncated: false })
    render(<QuickOpen root="/ws" workspaceName="workspace" onOpen={onOpen} onClose={onClose} />)
    const input = screen.getByRole('combobox', { name: 'Search files' })
    fireEvent.change(input, { target: { value: 'a' } })
    await screen.findByRole('option', { name: /a\.ts/ })
    expect(screen.getByText('workspace')).toBeTruthy()
    expect(screen.getByRole('dialog').classList.contains('files-qo')).toBe(true)
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText(/Open file/)).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('src/a.ts')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows the pending state and the first-200 caption when capped', async () => {
    let resolveSearch: ((value: { items: FileSearchResult[]; total: number; truncated: boolean }) => void) | undefined
    search.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve
        }),
    )
    render(<QuickOpen root="/ws" workspaceName="workspace" onOpen={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Loading files…')
    await waitFor(() => expect(search).toHaveBeenCalled())
    resolveSearch?.({ items: [item('src/a.ts', 'a.ts', [0])], total: 201, truncated: true })
    expect((await screen.findByTestId('quick-open-cap')).textContent).toBe(
      'Showing the first 200 of 201 matches. Refine your search.',
    )
  })

  it('moves the active highlight with mouse hover', async () => {
    search.mockResolvedValue({
      items: [item('src/a.ts', 'a.ts', [0]), item('src/b.ts', 'b.ts', [0])],
      total: 2,
      truncated: false,
    })
    render(<QuickOpen root="/ws" workspaceName="workspace" onOpen={vi.fn()} onClose={vi.fn()} />)
    const rows = await screen.findAllByRole('option')
    fireEvent.mouseEnter(rows[1])
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
    expect(rows[1].classList.contains('hi')).toBe(true)
    const input = screen.getByRole('combobox', { name: 'Search files' })
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[1].id)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(rows.filter((row) => row.classList.contains('bg-selected-fill'))).toHaveLength(1)
    expect(rows[0].classList.contains('bg-selected-fill')).toBe(true)
    expect(rows[1].classList.contains('bg-transparent')).toBe(true)
    expect(rows.every((row) => !row.className.includes('hover:bg-'))).toBe(true)
    expect(document.activeElement).toBe(input)
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    fireEvent(rows[1], press)
    expect(press.defaultPrevented).toBe(true)
  })

  it('keeps options out of the Tab order so focus cannot mark a different row from Enter', async () => {
    search.mockResolvedValue({ items: [item('AGENTS.md', 'AGENTS.md', []), item('README.md', 'README.md', [])], total: 2, truncated: false })
    const onOpen = vi.fn()
    render(<QuickOpen root="/ws" workspaceName="workspace" onOpen={onOpen} onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Search files' })
    const rows = await screen.findAllByRole('option')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(rows[1].getAttribute('aria-selected')).toBe('true')
    // A tab stop on row zero would show focus there while Enter opens row one.
    expect(rows.filter((row) => row.tabIndex >= 0)).toHaveLength(0)
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(rows[1].id)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('README.md')
  })

  it('registers Mod+P only when focus is outside a terminal', () => {
    const open = vi.fn()
    const outside = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    const inside = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    expect(filesQuickOpenShortcut(outside, false, open)).toBe(true)
    expect(filesQuickOpenShortcut(inside, true, open)).toBe(false)
    expect(open).toHaveBeenCalledOnce()
  })
})
