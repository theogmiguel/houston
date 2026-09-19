// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'
import { EditorLeaf } from './EditorLeaf'
import { setWindowFocusedForTests } from '../windowFocus'

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EditorLeaf focus geometry (ph-16b)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    setWindowFocusedForTests(true)
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

  async function renderLeaf(active: boolean): Promise<{ pane: HTMLElement; header: HTMLElement }> {
    const node: EditorNode = { kind: 'editor', id: 'focus-leaf', path: '/ws/file.ts' }
    await act(async () => {
      root.render(
        <EditorLeaf
          node={node}
          workspaceDir="/ws"
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
          onSplit={() => {}}
          active={active}
        />
      )
    })
    await flush()
    const pane = container.querySelector('.pane')
    const header = container.querySelector('.pane-head')
    if (!(pane instanceof HTMLElement) || !(header instanceof HTMLElement)) {
      throw new Error('EditorLeaf did not render its .pane/.pane-head')
    }
    return { pane, header }
  }

  it('an unfocused editor pane carries the plain --border, never .focus', async () => {
    const { pane } = await renderLeaf(false)
    expect(pane.classList.contains('focus')).toBe(false)
    expect(pane.className).toContain('border-[var(--border)]')
  })

  it('an active editor pane (window focused) gets .focus and --border-focus', async () => {
    const { pane } = await renderLeaf(true)
    expect(pane.classList.contains('focus')).toBe(true)
    expect(pane.className).toContain('border-[var(--border-focus)]')
  })

  it('an active editor pane lifts its header background off the rest-state token', async () => {
    const { header } = await renderLeaf(true)
    expect(header.className).not.toContain('bg-[var(--session-terminal-header-bg)]')
    expect(header.className).toContain('bg-[var(--raised)]')
  })

  it('an inactive editor pane keeps the rest-state header background', async () => {
    const { header } = await renderLeaf(false)
    expect(header.className).toContain('bg-[var(--session-terminal-header-bg)]')
  })
})
