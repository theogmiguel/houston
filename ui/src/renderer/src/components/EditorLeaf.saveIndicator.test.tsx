// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorView as CmView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorNode } from '../layout/tree'
import { EditorLeaf } from './EditorLeaf'
import { getBuffer } from '../editor/buffers'

await import('./EditorSurface')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('EditorLeaf save-in-flight indicator (Q11)', () => {
  let container: HTMLDivElement
  let root: Root
  let writeFileDeferred: Deferred<void>

  beforeEach(() => {
    vi.useFakeTimers()
    writeFileDeferred = deferred<void>()
    ;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
      readFile: vi.fn().mockResolvedValue('hello'),
      statFile: vi.fn().mockResolvedValue({ mtimeMs: 1 }),
      writeFile: vi.fn().mockImplementation(() => writeFileDeferred.promise)
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  function header(): HTMLElement {
    const el = container.querySelector('.pane-head')
    if (!el) throw new Error('.pane-head not found')
    return el as HTMLElement
  }

  function ctrlS(): void {
    const host = container.querySelector('.cm-content') as HTMLElement
    host.focus()
    host.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
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

  it('shows Saving on Ctrl+S while the write is in flight, then Saved, then clears -- dot suppressed throughout', async () => {
    const node: EditorNode = { kind: 'editor', id: 'leaf-1', path: '/ws/leaf-1.ts' }
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
    await makeDirty(node.path)

    expect(header().querySelector('[data-tooltip="Unsaved changes"]')).not.toBeNull()
    expect(header().querySelector('[aria-label="Saving"]')).toBeNull()

    ctrlS()
    await flush()

    expect(header().querySelector('[aria-label="Saving"]')).not.toBeNull()
    expect(header().querySelector('[data-tooltip="Unsaved changes"]')).toBeNull()

    await act(async () => {
      writeFileDeferred.resolve(undefined)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(header().querySelector('[aria-label="Saved"]')).not.toBeNull()
    expect(header().querySelector('[aria-label="Saving"]')).toBeNull()
    expect(header().querySelector('[data-tooltip="Unsaved changes"]')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(header().querySelector('[aria-label="Saved"]')).toBeNull()
    expect(header().querySelector('[aria-label="Saving"]')).toBeNull()
  })

  it('clears the spinner on a rejected save, with no stuck state', async () => {
    const node: EditorNode = { kind: 'editor', id: 'leaf-2', path: '/ws/leaf-2.ts' }
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
    await makeDirty(node.path)

    ctrlS()
    await flush()
    expect(header().querySelector('[aria-label="Saving"]')).not.toBeNull()

    await act(async () => {
      writeFileDeferred.reject(new Error('disk full'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(header().querySelector('[aria-label="Saving"]')).toBeNull()
    expect(header().querySelector('[aria-label="Saved"]')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(header().querySelector('[aria-label="Saving"]')).toBeNull()
    expect(header().querySelector('[aria-label="Saved"]')).toBeNull()
  })
})
