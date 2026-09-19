// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'
import { EditorLeaf } from './EditorLeaf'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EditorLeaf pane header alignment', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile: vi.fn().mockResolvedValue('hello'),
      statFile: vi.fn().mockResolvedValue({ mtimeMs: 1 }),
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

  async function renderLeaf(path: string): Promise<HTMLElement> {
    const node: EditorNode = { kind: 'editor', id: 'align-leaf', path }
    await act(async () => {
      root.render(
        <EditorLeaf
          node={node}
          workspaceDir="/ws"
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
          onSplit={() => {}}
        />
      )
    })
    await flush()
    const head = container.querySelector('.pane-head')
    if (!head) throw new Error('.pane-head not found')
    return head as HTMLElement
  }

  function isPushedRight(actions: HTMLElement): boolean {
    if (actions.classList.contains('ml-auto')) return true
    let prev = actions.previousElementSibling
    while (prev) {
      const cls = prev.classList
      if (cls.contains('ml-auto') || cls.contains('flex-1') || cls.contains('grow')) return true
      prev = prev.previousElementSibling
    }
    return false
  }

  it('pushes its action buttons to the right edge, as every other pane type does', async () => {
    const head = await renderLeaf('/ws/notes.md')
    const actions = head.querySelector('.head-actions') as HTMLElement | null
    expect(actions, '.head-actions not found in the editor pane header').not.toBeNull()
    expect(
      isPushedRight(actions!),
      'nothing in this header grows or pushes, so .head-actions renders packed left ' +
        'against the filename instead of flush right — give it ml-auto, or a flex-1 sibling ' +
        'before it (SessionPane uses head-meta ml-auto; BrowserPane uses its flex-1 url bar)'
    ).toBe(true)
  })

  it('holds for a markdown file, which is the case this was reported on', async () => {
    const head = await renderLeaf('/ws/README.md')
    const actions = head.querySelector('.head-actions') as HTMLElement
    expect(isPushedRight(actions)).toBe(true)
    expect(actions.childElementCount).toBeGreaterThan(0)
  })
})
