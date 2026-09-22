// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { importFails } = vi.hoisted(() => ({
  importFails: { value: false }
}))
vi.mock('./markdownPipeline', async (importOriginal) => {
  if (importFails.value) throw new Error('chunk load failed: markdownPipeline')
  return await importOriginal<typeof import('./markdownPipeline')>()
})
vi.mock('../houston/bridge', () => ({ openExternal: vi.fn(() => Promise.resolve()) }))

const { MarkdownPreview, loadMarkdownPipeline, resetMarkdownPipelineForTest } =
  await import('./MarkdownPreview')
await vi.importActual('./markdownPipeline')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MarkdownPreview lazy pipeline (fix round)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetMarkdownPipelineForTest()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    importFails.value = false
    act(() => root.unmount())
    container.remove()
  })

  function el(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`)
  }

  it('surfaces a chunk failure and retries it on the next attempt', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      importFails.value = true
      await act(async () => {
        root.render(<MarkdownPreview source={'# Later\n'} />)
        await expect(loadMarkdownPipeline()).rejects.toThrow()
      })

      expect(
        el('editor-markdown-load-error'),
        'a failed chunk must say so, not sit blank'
      ).not.toBeNull()
      expect(el('editor-markdown-load-error-detail')?.textContent?.length ?? 0).toBeGreaterThan(0)

      importFails.value = false
      await act(async () => {
        ;(el('editor-markdown-retry') as HTMLButtonElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
        )
        await loadMarkdownPipeline()
      })
      expect(el('editor-markdown-load-error')).toBeNull()
      expect(el('editor-markdown-body')?.querySelector('h1')?.textContent).toBe('Later')
    } finally {
      warn.mockRestore()
    }
  })

  it('shows a loading state while the chunk is in flight, then the document', async () => {
    act(() => root.render(<MarkdownPreview source={'# Late\n'} />))
    expect(el('editor-markdown-loading')).not.toBeNull()
    await act(async () => {
      await loadMarkdownPipeline()
    })
    expect(el('editor-markdown-loading')).toBeNull()
    expect(el('editor-markdown-body')?.querySelector('h1')?.textContent).toBe('Late')
  })
})
