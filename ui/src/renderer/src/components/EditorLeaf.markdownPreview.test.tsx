// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { EditorLeaf } = await import('./EditorLeaf')
await import('./EditorSurface')
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

const DOC = '# Heading\n\nsome *body* text\n'

describe('EditorLeaf markdown preview (Phase 6 item 4 batch 4)', () => {
  let container: HTMLDivElement
  let root: Root
  let readFile: ReturnType<typeof vi.fn<(path: string) => Promise<string>>>
  let headerPointerDowns: number

  beforeEach(() => {
    readFile = vi.fn<(path: string) => Promise<string>>().mockResolvedValue(DOC)
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile,
      statFile: vi.fn().mockResolvedValue({ mtimeMs: 1 }),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string) => {
      throw new Error(`unexpected invoke: ${cmd}`)
    })
    headerPointerDowns = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mount(path: string): Promise<void> {
    const node: EditorNode = { kind: 'editor', id: 'e1', path }
    await act(async () => {
      root.render(
        <EditorLeaf
          node={node}
          workspaceDir="/ws"
          onClose={() => {}}
          onHeaderPointerDown={() => {
            headerPointerDowns += 1
          }}
          onSplit={() => {}}
        />
      )
    })
    await flush()
  }

  function el(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`)
  }

  function toggle(): HTMLButtonElement | null {
    return el('editor-markdown-toggle') as HTMLButtonElement | null
  }

  async function settleRendered(): Promise<void> {
    for (let i = 0; i < 50 && !el('editor-markdown-body'); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1))
      })
    }
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.click()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
  }

  it('opens a .md leaf as an editable text buffer and previews it first', async () => {
    await mount('/ws/leaf-a.md')
    expect(readFile).toHaveBeenCalledWith('/ws/leaf-a.md')
    expect(invokeMock).not.toHaveBeenCalled()
    await settleRendered()
    expect(el('editor-preview-markdown')?.querySelector('h1')?.textContent).toBe('Heading')
    expect((el('cm-host') as HTMLElement).style.display).toBe('none')
    expect(toggle()?.getAttribute('aria-label')).toBe('Edit source')
  })

  it('round-trips: preview → source → preview', async () => {
    await mount('/ws/leaf-b.md')
    await click(toggle()!)
    expect(el('editor-preview-markdown')).toBeNull()
    expect((el('cm-host') as HTMLElement).style.display).not.toBe('none')

    await click(toggle()!)
    expect(el('editor-preview-markdown')).not.toBeNull()
    expect((el('cm-host') as HTMLElement).style.display).toBe('none')
  })

  it('focuses the editor when the preview is left', async () => {
    await mount('/ws/leaf-focus.md')
    await click(toggle()!)
    expect((el('cm-host') as HTMLElement).contains(document.activeElement)).toBe(true)
  })

  it('does not start a pane drag when the toggle is pressed (the header bails on buttons)', async () => {
    await mount('/ws/leaf-c.md')
    await act(async () => {
      toggle()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      for (let i = 0; i < 8; i++) await Promise.resolve()
    })
    expect(headerPointerDowns).toBe(0)
  })

  it('offers no toggle and no preview for an ordinary text file -- unchanged case', async () => {
    await mount('/ws/leaf.rs')
    expect(toggle()).toBeNull()
    expect(el('editor-preview-markdown')).toBeNull()
    expect((el('cm-host') as HTMLElement).style.display).not.toBe('none')
  })

  it('renders a failed .md read as the ordinary error block, with no toggle', async () => {
    readFile.mockRejectedValueOnce(new Error('cannot read file /ws/leaf-gone.md: No such file'))
    await mount('/ws/leaf-gone.md')
    expect(el('editor-preview-error')).not.toBeNull()
    expect(toggle()).toBeNull()
    expect(el('editor-preview-markdown')).toBeNull()
  })
})
