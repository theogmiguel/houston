// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { BrowserSurface } = await import('./BrowserSurface')
const { __resetNativeSuppressionForTests, setSuppressionSink } = await import('../../layout/nativeSuppression')
const { __resetBrowserSurfaceRegistryForTests } = await import('../../houston/browserSurfaceRegistry')

const RECT = { x: 0, y: 0, width: 400, height: 300 }

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function captureStateHandler(): (payload: Record<string, unknown>) => void {
  let handler: ((e: { payload: unknown }) => void) | null = null
  listenMock.mockImplementation((name: string, h: (e: { payload: unknown }) => void) => {
    if (name === 'browser://state') handler = h
    return Promise.resolve(() => {})
  })
  return (payload) => {
    if (!handler) throw new Error('listen(browser://state) was never called')
    act(() => (handler as (e: { payload: unknown }) => void)({ payload }))
  }
}

function statePayload(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    url: null,
    title: null,
    favicon: null,
    loading: false,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    error: null,
    mountFailed: false,
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  listenMock.mockReset()
  invokeMock.mockReset()
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'browser_mount' || cmd === 'browser_resize') return Promise.resolve(RECT)
    return Promise.resolve(undefined)
  })
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  __resetNativeSuppressionForTests()
  __resetBrowserSurfaceRegistryForTests()
  setSuppressionSink(null)
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

describe('BrowserPane under a mocked Tauri host (C9)', () => {
  it('reserves no gutter on the native placeholder — the ring it made room for is gone', async () => {
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-gutter'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
          
        />
      )
    })
    await flush()
    const host = container.querySelector('[data-browser-surface-id="leaf-gutter"]')
    if (!(host instanceof HTMLElement)) throw new Error('native placeholder not rendered')
    expect(host.className).not.toContain('mx-[2px]')
    expect(host.className).not.toContain('mb-[2px]')
  })

  it('mounts the native surface keyed by the leaf’s own node id', async () => {
    const fire = captureStateHandler()
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-x'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    expect(invokeMock).toHaveBeenCalledWith(
      'browser_mount',
      expect.objectContaining({ id: 'leaf-x', url: 'https://example.test/' })
    )
    expect(container.querySelector('[data-browser-surface-id="leaf-x"]')).not.toBeNull()

    fire(statePayload('leaf-x', { canGoBack: true, canGoForward: false, url: 'https://example.test/' }))

    const back = container.querySelector('button[aria-label="Back"]')
    const forward = container.querySelector('button[aria-label="Forward"]')
    if (!(back instanceof HTMLButtonElement) || !(forward instanceof HTMLButtonElement)) {
      throw new Error('nav buttons not rendered')
    }
    expect(back.disabled).toBe(false)
    expect(forward.disabled).toBe(true)
  })

  it('ignores a browser://state event for a DIFFERENT leaf’s surface id', async () => {
    const fire = captureStateHandler()
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-x'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    fire(statePayload('leaf-other', { canGoBack: true, canGoForward: true }))

    const back = container.querySelector('button[aria-label="Back"]')
    const forward = container.querySelector('button[aria-label="Forward"]')
    if (!(back instanceof HTMLButtonElement) || !(forward instanceof HTMLButtonElement)) {
      throw new Error('nav buttons not rendered')
    }
    expect(back.disabled).toBe(true)
    expect(forward.disabled).toBe(true)
  })

  it('back/forward/reload drive the browser_* commands keyed by this leaf’s own id', async () => {
    const fire = captureStateHandler()
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-x'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()
    fire(statePayload('leaf-x', { url: 'https://example.test/', canGoBack: true, canGoForward: true }))

    const back = container.querySelector('button[aria-label="Back"]')
    const forward = container.querySelector('button[aria-label="Forward"]')
    const reload = container.querySelector('button[aria-label="Reload"]')
    if (
      !(back instanceof HTMLElement) ||
      !(forward instanceof HTMLElement) ||
      !(reload instanceof HTMLElement)
    ) {
      throw new Error('chrome buttons not rendered')
    }

    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_go_back', { id: 'leaf-x' })

    act(() => forward.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_go_forward', { id: 'leaf-x' })

    act(() => reload.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_reload', { id: 'leaf-x', bypassCache: false })
    act(() => reload.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_reload', {id: 'leaf-x', bypassCache: true})
  })

  it('opening fullscreen on one leaf hides every OTHER leaf’s native child, but not its own', async () => {
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-fullscreen'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const rootB = createRoot(containerB)
    act(() => {
      rootB.render(
        <BrowserSurface
          tabId={'leaf-other'} initialUrl={'https://other.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    invokeMock.mockClear()

    const toggle = container.querySelector('button[aria-label="Full screen"]')
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('fullscreen toggle not rendered')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('browser_set_visible', {
      id: 'leaf-other',
      visible: false,
      reason: 'modal'
    })
    expect(invokeMock).not.toHaveBeenCalledWith(
      'browser_set_visible',
      expect.objectContaining({ id: 'leaf-fullscreen', visible: false, reason: 'modal' })
    )

    invokeMock.mockClear()
    const exitBtn = document.body.querySelector('[data-testid="browser-fullscreen-exit"]')
    if (!(exitBtn instanceof HTMLButtonElement)) throw new Error('fullscreen exit button not rendered')
    act(() => exitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('browser_set_visible', {
      id: 'leaf-other',
      visible: true,
      reason: 'modal'
    })

    act(() => rootB.unmount())
    containerB.remove()
  })

  it('unmounting the pane while fullscreen is open still releases the suppression (no leaked hide)', async () => {
    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const rootB = createRoot(containerB)
    act(() => {
      rootB.render(
        <BrowserSurface
          tabId={'leaf-other-2'} initialUrl={'https://other.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-x'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()

    const toggle = container.querySelector('button[aria-label="Full screen"]')
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('fullscreen toggle not rendered')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
    invokeMock.mockClear()

    act(() => root.unmount())
    root = createRoot(container)
    await flush()

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('browser_set_visible', {
      id: 'leaf-other-2',
      visible: true,
      reason: 'modal'
    }))

    act(() => rootB.unmount())
    containerB.remove()
  })

  it('shows the mount-recovery banner when browser://state reports mountFailed', async () => {
    const fire = captureStateHandler()
    act(() => {
      root.render(
        <BrowserSurface
          tabId={'leaf-x'} initialUrl={'https://example.test/'} onTitleChange={() => {}}
          workspace="/tmp/tr-test-ws" active
        />
      )
    })
    await flush()
    expect(container.querySelector('[data-browser-surface-id="leaf-x"]')).not.toBeNull()

    fire(statePayload('leaf-x', { mountFailed: true }))
    await flush()

    const banner = container.querySelector('[data-testid="browser-pane-mount-recovery"]')
    expect(banner?.textContent).toContain('Browser webview failed to mount. Retry to recreate it.')
    expect(container.querySelector('[data-browser-surface-id="leaf-x"]')).toBeNull()
  })
  it('opens a page popup as a new persisted side-panel tab', async () => {
    let popup: ((event: {payload: {id: string; url: string}}) => void) | undefined
    listenMock.mockImplementation((name, handler) => {if (name === 'browser://open-url') popup = handler; return Promise.resolve(() => {})})
    act(() => root.render(<BrowserSurface tabId="source" initialUrl="https://source.test/" workspace="/work" active onTitleChange={() => {}} />))
    await flush()
    act(() => popup!({payload:{id:'source',url:'https://popup.test/'}}))
    const state = JSON.parse(localStorage.getItem('tr-inspector-tabs:/work')!)
    expect(state.openTabs).toHaveLength(1)
    const id = state.active.slice(8)
    expect(id).not.toBe('source')
    expect(localStorage.getItem(`tr-inspector-browser-url:/work:${id}`)).toBe('https://popup.test/')
  })
  it('shows a failed page with retry and raw error details', async () => {
    const fire = captureStateHandler()
    act(() => root.render(<BrowserSurface tabId="failed" initialUrl="http://localhost:3000/" workspace="/work" active onTitleChange={() => {}} />))
    await flush()
    fire(statePayload('failed',{url:'http://localhost:3000/',error:{kind:'load',message:'Connection refused',failingUrl:'http://localhost:3000/'}}))
    const failed = container.querySelector('[data-testid="browser-unreachable-state"]')!
    expect(failed.textContent).toContain('localhost:3000')
    const details = [...failed.querySelectorAll('button')].find((button) => button.textContent === 'Show details')!
    act(() => details.click())
    expect(failed.textContent).toContain('Connection refused')
    expect(failed.textContent).toContain('1 attempt')
    const retry = [...failed.querySelectorAll('button')].find((button) => button.textContent?.includes('Retry'))!
    act(() => retry.click())
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_reload',{id:'failed',bypassCache:false})
  })

})

