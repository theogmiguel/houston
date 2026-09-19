// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView as CmView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'
import { EditorLeaf } from './EditorLeaf'
import { cmCutSelection, cmPasteClipboard } from '../editor/cmClipboard'

await import('./EditorSurface')

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EditorLeaf CM host right-click menu (R3)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile: vi.fn().mockResolvedValue('hello'),
      statFile: vi.fn().mockResolvedValue({ mtimeMs: 1 })
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function cmHost(): HTMLElement {
    const el = container.querySelector('[data-testid="cm-host"]')
    if (!el) throw new Error('cm host not found')
    return el as HTMLElement
  }

  function getView(): CmView {
    const dom = cmHost().querySelector('.cm-editor') as HTMLElement | null
    const view = dom && CmView.findFromDOM(dom)
    if (!view) throw new Error('CM view not mounted')
    return view
  }

  function rightClick(): void {
    act(() => {
      cmHost().dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })
      )
    })
  }

  function menuButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().startsWith(label)
    )
  }

  async function openLeaf(path: string): Promise<void> {
    const node: EditorNode = { kind: 'editor', id: path, path }
    await act(async () => {
      root.render(
        <EditorLeaf node={node} workspaceDir="/ws" onClose={() => {}} onHeaderPointerDown={() => {}} onSplit={() => {}} />
      )
    })
    await flush()
    for (let i = 0; i < 10 && !cmHost().querySelector('.cm-editor'); i++) await flush()
  }

  it('opens on contextmenu over the CM host with Copy, Cut, Paste, a divider, then Select All', async () => {
    await openLeaf('/ws/leaf-menu.txt')

    expect(menuButton('Copy')).toBeUndefined()
    rightClick()

    expect(menuButton('Copy')).not.toBeUndefined()
    expect(menuButton('Cut')).not.toBeUndefined()
    expect(menuButton('Paste')).not.toBeUndefined()
    const selectAll = menuButton('Select All')
    expect(selectAll).not.toBeUndefined()
    expect(selectAll?.textContent).toContain('Ctrl+A')
    expect(container.querySelector('.ctx-sep')).not.toBeNull()
  })

  it('hides Cut and Paste when the document is read-only, shows them again once it is not', async () => {
    await openLeaf('/ws/leaf-readonly.txt')
    const view = getView()

    act(() => {
      view.setState(
        EditorState.create({ doc: view.state.doc, extensions: [EditorState.readOnly.of(true)] })
      )
    })
    rightClick()
    expect(menuButton('Copy')).not.toBeUndefined()
    expect(menuButton('Cut')).toBeUndefined()
    expect(menuButton('Paste')).toBeUndefined()

    act(() => {
      view.setState(EditorState.create({ doc: view.state.doc, extensions: [] }))
    })
    rightClick()
    expect(menuButton('Cut')).not.toBeUndefined()
    expect(menuButton('Paste')).not.toBeUndefined()
  })

  it('Select All selects the whole document', async () => {
    await openLeaf('/ws/leaf-selectall.txt')
    const view = getView()

    rightClick()
    act(() => menuButton('Select All')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(view.state.selection.main.from).toBe(0)
    expect(view.state.selection.main.to).toBe(view.state.doc.length)
  })

  it('Copy/Cut/Paste mutate the CM view directly -- never document.execCommand', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const readText = vi.fn().mockResolvedValue('PASTED')
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText } })
    const execCommand = vi.fn()
    document.execCommand = execCommand

    await openLeaf('/ws/leaf-actions.txt')
    const view = getView()
    act(() => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    })

    rightClick()
    act(() => menuButton('Copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(view.state.doc.toString()).toBe('hello')
    expect(execCommand).not.toHaveBeenCalled()

    rightClick()
    await act(async () => {
      menuButton('Cut')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(view.state.doc.toString()).toBe('')
    expect(execCommand).not.toHaveBeenCalled()

    rightClick()
    await act(async () => {
      menuButton('Paste')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(readText).toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('PASTED')
    expect(execCommand).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('Cut leaves the document unchanged when the clipboard write is rejected', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText: vi.fn() } })

    await openLeaf('/ws/leaf-cut-fail.txt')
    const view = getView()
    act(() => {
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    })

    rightClick()
    await act(async () => {
      menuButton('Cut')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('hello')
    expect(view.state.doc.toString()).toBe('hello')

    vi.unstubAllGlobals()
  })

  it('does not dispatch a pending paste after the leaf is closed', async () => {
    let resolveRead: (text: string) => void = () => {}
    const readText = vi.fn(() => new Promise<string>((resolve) => (resolveRead = resolve)))
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined), readText }
    })

    await openLeaf('/ws/leaf-paste-destroy.txt')
    const view = getView()

    rightClick()
    act(() => menuButton('Paste')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(readText).toHaveBeenCalled()

    act(() => root.unmount())

    await act(async () => {
      resolveRead('PASTED')
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(view.state.doc.toString()).not.toContain('PASTED')

    vi.unstubAllGlobals()
  })

  it('repositions the caret when right-clicking outside the current selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText, readText: vi.fn() } })

    await openLeaf('/ws/leaf-reposition.txt')
    const view = getView()
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'hello world' } })
      view.dispatch({ selection: { anchor: 0, head: 5 } })
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue(6)

    rightClick()
    expect(view.state.selection.main.from).toBe(6)
    expect(view.state.selection.main.to).toBe(6)
    expect(menuButton('Copy')?.disabled).toBe(true)

    act(() => menuButton('Copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(writeText).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('cmCutSelection and cmPasteClipboard no-op against a read-only view even called directly', () => {
    const view = new CmView({
      state: EditorState.create({
        doc: 'hello',
        selection: { anchor: 0, head: 5 },
        extensions: [EditorState.readOnly.of(true)]
      })
    })
    const onError = vi.fn()

    cmCutSelection(view, { onError })
    expect(view.state.doc.toString()).toBe('hello')

    cmPasteClipboard(view, { onError, isStale: () => false })
    expect(view.state.doc.toString()).toBe('hello')

    view.destroy()
  })
})
