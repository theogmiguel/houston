// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'
import { QuickOpenOverlay } from './QuickOpenOverlay'
import { DEFAULT_GRID_ID, gridStorageKey, loadLayout, type LayoutNode } from './layout/tree'

const search = vi.hoisted(() => vi.fn())
vi.mock('./houston/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./houston/bridge')>()
  return { ...actual, searchFilePaths: search }
})

function editorPaths(node: LayoutNode | null): string[] {
  if (!node) return []
  if (node.kind === 'editor') return [node.path]
  if (node.kind === 'split' || node.kind === 'stack') return (node.children as LayoutNode[]).flatMap(editorPaths)
  return []
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  search.mockResolvedValue({
    items: [{ path: 'src/a.ts', name: 'a.ts', isDir: false, nameIndices: [0], pathIndices: [] }],
    total: 1,
    truncated: false,
  })
})
afterEach(() => {
  harness?.unmount()
  harness = null
  cleanup()
})

describe('App Quick Open', () => {
  it('opens the picked workspace-relative result as an absolute editor path', async () => {
    harness = await renderReadyApp()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))
    })
    const input = await screen.findByRole('combobox', { name: 'Search files' })
    fireEvent.change(input, { target: { value: 'a' } })
    await screen.findByRole('option', { name: /a\.ts/ })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(editorPaths(loadLayout(gridStorageKey('/tmp/project', DEFAULT_GRID_ID)).tree)).toEqual([
        '/tmp/project/src/a.ts',
      ])
    )
  })

  it('focuses the open editor rather than opening the same file twice', async () => {
    harness = await renderReadyApp()
    for (let pick = 0; pick < 2; pick++) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true }))
      })
      const input = await screen.findByRole('combobox', { name: 'Search files' })
      fireEvent.change(input, { target: { value: 'a' } })
      await screen.findByRole('option', { name: /a\.ts/ })
      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search files' })).toBeNull())
    }
    await waitFor(() =>
      expect(editorPaths(loadLayout(gridStorageKey('/tmp/project', DEFAULT_GRID_ID)).tree)).toEqual([
        '/tmp/project/src/a.ts',
      ])
    )
  })

  it('joins a Windows root that ends in a separator without doubling it', async () => {
    const onOpen = vi.fn()
    render(<QuickOpenOverlay open workspace={'C:\\ws\\'} onClose={vi.fn()} onOpen={onOpen} />)
    const input = await screen.findByRole('combobox', { name: 'Search files' })
    fireEvent.change(input, { target: { value: 'a' } })
    await screen.findByRole('option', { name: /a\.ts/ })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('C:\\ws/src/a.ts')
  })
})
