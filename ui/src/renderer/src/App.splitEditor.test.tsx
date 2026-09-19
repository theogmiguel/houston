// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { type AppHarness, deliverControl, renderReadyApp, resetHarness } from './test/appTestHarness'
import { DEFAULT_GRID_ID, gridStorageKey, loadLayout, type LayoutNode, type SplitNode } from './layout/tree'
import { getBuffer } from './editor/buffers'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function openEditor(path: string): Promise<void> {
  ;(window.houston.pickFile as unknown as Mock).mockResolvedValueOnce(path)
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  await flush()
}

function editorLeaves(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.editor-leaf'))
}

function splitButton(leaf: HTMLElement, label: 'Split right' | 'Split down'): HTMLButtonElement {
  const btn = Array.from(leaf.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label
  )
  if (!btn) throw new Error(`no "${label}" button rendered`)
  return btn
}

function findEditorSplit(node: LayoutNode | null, path: string): SplitNode | null {
  if (!node || node.kind !== 'split') return null
  if (
    node.children.length === 2 &&
    node.children.every((c) => c.kind === 'editor' && c.path === path)
  ) {
    return node
  }
  for (const c of node.children) {
    const found = findEditorSplit(c, path)
    if (found) return found
  }
  return null
}

describe('editor pane split (Phase 6 item 4 batch 2)', () => {
  let harness: AppHarness | null = null

  beforeEach(async () => {
    harness = await renderReadyApp()
  })

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('both split buttons are present and labelled -- shortcut on the tooltip only where a route exists', async () => {
    await openEditor('/tmp/project/a.ts')
    const leaf = editorLeaves(harness!.container)[0]

    const right = splitButton(leaf, 'Split right')
    const down = splitButton(leaf, 'Split down')
    expect(right.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Split right')
    expect(down.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Split down (Ctrl+Shift+D)')
    expect(down.getAttribute('aria-label')).toBe('Split down')
  })

  it('Split right inserts a second editor leaf on the SAME path, row-wise', async () => {
    await openEditor('/tmp/project/a.ts')
    expect(editorLeaves(harness!.container)).toHaveLength(1)

    act(() => {
      splitButton(editorLeaves(harness!.container)[0], 'Split right').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(2)
    const { tree } = loadLayout(gridStorageKey('/tmp/project', DEFAULT_GRID_ID))
    const split = findEditorSplit(tree, '/tmp/project/a.ts')
    if (!split) throw new Error('no split node holding the two editor leaves')
    expect(split.dir).toBe('row')
    const ids = split.children.map((c) => (c.kind === 'editor' ? c.id : null))
    expect(new Set(ids).size).toBe(2)
  })

  it('Split down inserts a second editor leaf on the SAME path, column-wise', async () => {
    await openEditor('/tmp/project/b.ts')

    act(() => {
      splitButton(editorLeaves(harness!.container)[0], 'Split down').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(2)
    const { tree } = loadLayout(gridStorageKey('/tmp/project', DEFAULT_GRID_ID))
    const split = findEditorSplit(tree, '/tmp/project/b.ts')
    if (!split) throw new Error('no split node holding the two editor leaves')
    expect(split.dir).toBe('col')
  })

  it.each([
    ['Split right', '/tmp/project/c.ts'],
    ['Split down', '/tmp/project/c2.ts']
  ] as const)("the %s button's click handler stops propagation before acting", async (label, path) => {
    await openEditor(path)
    const leaf = editorLeaves(harness!.container)[0]
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true })
    const stopSpy = vi.spyOn(evt, 'stopPropagation')

    act(() => {
      splitButton(leaf, label).dispatchEvent(evt)
    })
    await flush()

    expect(stopSpy).toHaveBeenCalled()
  })

  it('Ctrl+Shift+D splits from the keyboard and never reaches CodeMirror\'s own document', async () => {
    await openEditor('/tmp/project/d.ts')
    const host = harness!.container.querySelector('.cm-content') as HTMLElement
    expect(host).not.toBeNull()
    const docBefore = getBuffer('/tmp/project', '/tmp/project/d.ts')?.state.doc.toString()

    act(() => {
      host.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'd',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(2)
    expect(getBuffer('/tmp/project', '/tmp/project/d.ts')?.state.doc.toString()).toBe(docBefore)
  })

  it('Ctrl+Shift+D does nothing while "Enable shortcuts" is off, but the button still works', async () => {
    await openEditor('/tmp/project/g.ts')
    deliverControl({ type: 'keymap', overrides: { bindings: {}, shortcuts_enabled: false } })
    await flush()

    const host = harness!.container.querySelector('.cm-content') as HTMLElement
    act(() => {
      host.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'd',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(1)

    act(() => {
      splitButton(editorLeaves(harness!.container)[0], 'Split down').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(2)
  })

  it('a bare "d" (no modifiers) does not split -- App\'s own global "d" cannot reach an editor', async () => {
    await openEditor('/tmp/project/e.ts')
    const host = harness!.container.querySelector('.cm-content') as HTMLElement

    act(() => {
      host.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })
      )
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(1)
  })

  it('an unsplit editor pane still closes normally', async () => {
    await openEditor('/tmp/project/f.ts')
    expect(editorLeaves(harness!.container)).toHaveLength(1)

    const closeBtn = Array.from(
      editorLeaves(harness!.container)[0].querySelectorAll('button')
    ).find((b) => b.getAttribute('aria-label') === 'Close')
    if (!closeBtn) throw new Error('no editor Close button rendered')

    act(() => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()

    expect(editorLeaves(harness!.container)).toHaveLength(0)
  })
})
