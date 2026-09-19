// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { BrowserPane } = await import('./BrowserPane')
const { __resetNativeSuppressionForTests, setSuppressionSink } = await import('../layout/nativeSuppression')
const { __resetBrowserSurfaceRegistryForTests } = await import('../houston/browserSurfaceRegistry')

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
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-gutter', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          active={true}
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
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
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
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
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
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
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
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
  })

  it('opening fullscreen on one leaf hides every OTHER leaf’s native child, but not its own', async () => {
    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-fullscreen', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
    await flush()

    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const rootB = createRoot(containerB)
    act(() => {
      rootB.render(
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-other', url: 'https://other.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
    await flush()

    invokeMock.mockClear()

    const toggle = container.querySelector('button[aria-label="Expand browser to full screen"]')
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
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-other-2', url: 'https://other.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
    await flush()

    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
    await flush()

    const toggle = container.querySelector('button[aria-label="Expand browser to full screen"]')
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('fullscreen toggle not rendered')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    await flush()
    invokeMock.mockClear()

    act(() => root.unmount())
    root = createRoot(container)
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('browser_set_visible', {
      id: 'leaf-other-2',
      visible: true,
      reason: 'modal'
    })

    act(() => rootB.unmount())
    containerB.remove()
  })

  it('shows the mount-recovery banner when browser://state reports mountFailed', async () => {
    const fire = captureStateHandler()
    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
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
})

describe('BrowserPane detach trigger (C12)', () => {
  function renderPane(): void {
    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: 'leaf-x', url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })
  }

  it('detaches through browser_detach and then offers reattach', async () => {
    renderPane()
    await flush()

    const button = container.querySelector('[data-testid="browser-detach-leaf-x"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('detach button not rendered')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()

    expect(invokeMock).toHaveBeenCalledWith('browser_detach', { id: 'leaf-x' })

    const after = container.querySelector('[data-testid="browser-detach-leaf-x"]')
    if (!(after instanceof HTMLButtonElement)) throw new Error('detach button vanished')
    expect(after.getAttribute('aria-pressed')).toBe('true')
    expect(after.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Reattach into the grid')

    await act(async () => {
      after.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()
    expect(invokeMock).toHaveBeenCalledWith('browser_reattach', { id: 'leaf-x' })
  })

  it('shows why a detach failed rather than doing nothing visible', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'browser_mount' || cmd === 'browser_resize') return Promise.resolve(RECT)
      if (cmd === 'browser_detach')
        return Promise.reject(new Error('browser: no live browser surface with id "leaf-x"'))
      return Promise.resolve(undefined)
    })
    renderPane()
    await flush()

    const button = container.querySelector('[data-testid="browser-detach-leaf-x"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('detach button not rendered')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await flush()

    const banner = container.querySelector('[data-testid="browser-detach-error-leaf-x"]')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('no live browser surface')
  })
})
