// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

const { useBrowserOpenRequest } = await import('./browserOpenRequest')

function captureHandler(): {
  fire: (payload: { workspaceId: string }) => void
  dispose: ReturnType<typeof vi.fn>
} {
  const dispose = vi.fn()
  let handler: ((e: { payload: unknown }) => void) | null = null
  listenMock.mockImplementation((name: string, h: (e: { payload: unknown }) => void) => {
    expect(name).toBe('browser://open-request')
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

function Probe({ onRequest }: { onRequest: (ws: string) => void }): null {
  useBrowserOpenRequest(onRequest)
  return null
}

async function mount(onRequest: (ws: string) => void): Promise<void> {
  act(() => {
    root.render(<Probe onRequest={onRequest} />)
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

describe('useBrowserOpenRequest', () => {
  it('subscribes to nothing outside Tauri', async () => {
    isTauriMock.mockReturnValue(false)
    await mount(() => {})
    expect(listenMock).not.toHaveBeenCalled()
  })

  it('forwards the workspace the host asked for', async () => {
    const { fire } = captureHandler()
    const seen: string[] = []
    await mount((ws) => seen.push(ws))
    fire({ workspaceId: '/home/u/proj' })
    expect(seen).toEqual(['/home/u/proj'])
  })

  it('calls the LATEST callback after a re-render, without resubscribing', async () => {
    const { fire } = captureHandler()
    const first: string[] = []
    const second: string[] = []
    await mount((ws) => first.push(ws))
    await mount((ws) => second.push(ws))
    fire({ workspaceId: '/home/u/proj' })
    expect(first).toEqual([])
    expect(second).toEqual(['/home/u/proj'])
    expect(listenMock).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes on unmount', async () => {
    const { dispose } = captureHandler()
    await mount(() => {})
    act(() => root.unmount())
    root = createRoot(container)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
