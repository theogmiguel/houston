// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView as CmView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'
import { EditorLeaf } from './EditorLeaf'
import { getBuffer } from '../editor/buffers'

await import('./EditorSurface')

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  })
}

describe('EditorLeaf conflict bar copy (Phase 6 item 4 batch 2)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    const statFile = vi
      .fn<(path: string) => Promise<{ mtimeMs: number } | null>>()
      .mockResolvedValueOnce({ mtimeMs: 1 })
      .mockResolvedValue({ mtimeMs: 2 })
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile: vi.fn().mockResolvedValue('hello'),
      statFile,
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function ctrlS(): void {
    const host = container.querySelector('.cm-content') as HTMLElement
    host.focus()
    host.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    )
  }

  async function makeDirty(path: string): Promise<void> {
    let buf = getBuffer('/ws', path)
    for (let i = 0; i < 10 && !buf; i++) {
      await flush()
      buf = getBuffer('/ws', path)
    }
    if (!buf) throw new Error(`buffer never loaded for ${path}`)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new CmView({ state: buf.state, parent })
    act(() => {
      view.dispatch({ changes: { from: 0, insert: 'x' } })
    })
    view.destroy()
    parent.remove()
    await flush()
  }

  it('tells the user the save did not happen, not only that the file changed', async () => {
    const path = '/ws/conflict.ts'
    const node: EditorNode = { kind: 'editor', id: 'e1', path }
    await act(async () => {
      root.render(
        <EditorLeaf node={node} workspaceDir="/ws" onClose={() => {}} onHeaderPointerDown={() => {}} onSplit={() => {}} />
      )
    })
    await flush()
    await makeDirty(path)

    act(() => ctrlS())
    await flush()

    expect(getBuffer('/ws', path)?.conflict).toBe(true)
    const bar = Array.from(container.querySelectorAll('div'))
      .filter((d) => d.textContent?.includes('File changed on disk'))
      .at(-1)
    expect(bar).toBeDefined()
    expect(bar?.textContent).toMatch(/save.*(didn't go through|blocked|not saved)/i)
    expect(bar?.querySelector('button')?.textContent).toBe('Reload')
  })
})
