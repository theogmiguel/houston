// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

const { useBrowserFocus } = await import('./browserFocus')

function captureFocusHandler(): {
  fire: (payload: { id: string }) => void
  dispose: ReturnType<typeof vi.fn>
} {
  const dispose = vi.fn()
  let handler: ((e: { payload: unknown }) => void) | null = null
  listenMock.mockImplementation((name: string, h: (e: { payload: unknown }) => void) => {
    expect(name).toBe('browser://focus')
    handler = h
    return Promise.resolve(dispose)
  })
  return {
    fire: (payload) => {
      if (!handler) throw new Error('listen() was never called')
      act(() => (handler as (e: { payload: unknown }) => void)({ payload }))
    },
    dispose
  }
}

let container: HTMLDivElement
let root: Root

function Probe({ onFocus }: { onFocus: (id: string) => void }): null {
  useBrowserFocus(onFocus)
  return null
}

async function mount(onFocus: (id: string) => void): Promise<void> {
  act(() => {
    root.render(<Probe onFocus={onFocus} />)
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  listenMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useBrowserFocus', () => {
  it('subscribes to nothing under Electron', async () => {
    isTauriMock.mockReturnValue(false)
    const seen: string[] = []
    await mount((id) => seen.push(id))
    expect(listenMock).not.toHaveBeenCalled()
  })

  it('forwards every event id, whichever surface it names', async () => {
    const { fire } = captureFocusHandler()
    const seen: string[] = []
    await mount((id) => seen.push(id))
    fire({ id: 'b1' })
    fire({ id: 'right-panel-browser' })
    expect(seen).toEqual(['b1', 'right-panel-browser'])
  })

  it('calls the LATEST callback after a re-render, without resubscribing', async () => {
    const { fire } = captureFocusHandler()
    const first: string[] = []
    const second: string[] = []
    await mount((id) => first.push(id))
    await mount((id) => second.push(id))
    fire({ id: 'b1' })
    expect(first).toEqual([])
    expect(second).toEqual(['b1'])
    expect(listenMock).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes on unmount', async () => {
    const { dispose } = captureFocusHandler()
    await mount(() => {})
    act(() => root.unmount())
    root = createRoot(container)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
