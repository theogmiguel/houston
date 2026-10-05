// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('./host', () => ({ isTauri: () => isTauriMock() }))

const { useBrowserOpenRequest, useBrowserPaneLoad, reuseSideBrowser, routeBrowserOpenRequest } = await import('./browserOpenRequest')

function captureHandler(): {
  fire: (payload: { workspaceId: string; url: string }) => void
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

function Probe({ onRequest }: { onRequest: (ws: string, url: string) => void }): null {
  useBrowserOpenRequest(onRequest)
  return null
}

async function mount(onRequest: (ws: string, url: string) => void): Promise<void> {
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

  it('forwards the workspace and the url the host asked for', async () => {
    const { fire } = captureHandler()
    const seen: Array<[string, string]> = []
    await mount((ws, url) => seen.push([ws, url]))
    fire({ workspaceId: '/home/u/proj', url: 'http://127.0.0.1:4388/' })
    expect(seen).toEqual([['/home/u/proj', 'http://127.0.0.1:4388/']])
  })

  it('calls the LATEST callback after a re-render, without resubscribing', async () => {
    const { fire } = captureHandler()
    const first: string[] = []
    const second: string[] = []
    await mount((ws) => first.push(ws))
    await mount((ws) => second.push(ws))
    fire({ workspaceId: '/home/u/proj', url: 'http://x.test/' })
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


describe('native browser reveal routing', () => {
  it('does not restore a legacy side browser', () => {
    localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'browser', id: 'other', url: 'https://other.test/' }, { kind: 'browser', id: 'target', url: 'https://current.test/' }], active: 0 }))
    const load = vi.fn()
    function Loader(): null { useBrowserPaneLoad('target', load); return null }
    act(() => root.render(<Loader />))
    const opens: unknown[] = []
    const listener = (event: Event): void => { opens.push((event as CustomEvent).detail) }
    window.addEventListener('houston:side-open', listener)
    expect(reuseSideBrowser('/work', 'https://next.test/', 'target')).toBe(false)
    expect(opens).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(reuseSideBrowser('/work', 'https://next.test/', 'missing')).toBe(false)
    expect(opens).toHaveLength(0)
    window.removeEventListener('houston:side-open', listener)
  })

  it('does not load a URL into a stale side browser tab', () => {
    localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'browser', id: 'target', url: 'https://current.test/' }], active: 0 }))
    const load = vi.fn()
    function Loader(): null { useBrowserPaneLoad('target', load); return null }
    act(() => root.render(<Loader />))
    expect(reuseSideBrowser('/work', 'https://next.test/')).toBe(false)
    expect(load).not.toHaveBeenCalled()
    expect(reuseSideBrowser('/empty', 'https://next.test/')).toBe(false)
  })
})

it('routes explicit grid, side and unknown surfaces without dispatching navigation or loads', () => {
  const open = vi.fn(), reveal = vi.fn(() => true), load = vi.fn()
  function Loader(): null { useBrowserPaneLoad('target', load); return null }
  act(() => root.render(<Loader />))
  routeBrowserOpenRequest('/work', 'https://next.test/', 'target', reveal, open)
  expect(reveal).toHaveBeenCalledWith('/work', 'target')
  expect(open).not.toHaveBeenCalled()
  expect(load).not.toHaveBeenCalled()
  reveal.mockReturnValue(false)
  localStorage.setItem('tr-side:/work', JSON.stringify({ tabs: [{ kind: 'scm' }, { kind: 'files' }, { kind: 'browser', id: 'target', url: 'https://current.test/' }], active: 0 }))
  routeBrowserOpenRequest('/work', 'https://next.test/', 'target', reveal, open)
  routeBrowserOpenRequest('/work', 'https://next.test/', 'unknown', reveal, open)
  expect(open).not.toHaveBeenCalled()
  expect(load).not.toHaveBeenCalled()
  routeBrowserOpenRequest('/empty', 'https://next.test/', undefined, reveal, open)
  expect(open).toHaveBeenCalledExactlyOnceWith('/empty', 'https://next.test/')
})
