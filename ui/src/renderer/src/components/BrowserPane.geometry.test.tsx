// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { BrowserPane } = await import('./BrowserPane')
const { WEBVIEW_HOST_CLS } = await import('./panelChrome')
const { __resetNativeSuppressionForTests, setSuppressionSink } = await import(
  '../layout/nativeSuppression'
)
const { __resetBrowserSurfaceRegistryForTests } = await import('../houston/browserSurfaceRegistry')

const RECT = { x: 0, y: 0, width: 400, height: 300 }
const LEAF_ID = 'leaf-geometry'

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
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

describe('the grid browser pane fills its leaf (M6)', () => {
  it('carries height across the portal slot, same chain as the right panel', () => {
    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: LEAF_ID, url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
        />
      )
    })

    const placeholder = container.querySelector('[data-browser-surface-id]')
    expect(placeholder).not.toBeNull()
    for (const cls of WEBVIEW_HOST_CLS.split(' ')) {
      expect(placeholder?.classList.contains(cls)).toBe(true)
    }

    const slot = placeholder?.parentElement
    expect(slot?.style.flexGrow).toBe('1')
    const host = slot?.parentElement
    expect(host?.classList.contains('flex')).toBe(true)
  })
})


describe('native browser device presets', () => {
  async function mountBrowser(): Promise<void> {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    await act(async () => {
      root.render(<BrowserPane node={{ kind: 'browser', id: LEAF_ID, url: 'https://example.test/' }} workspaceDir="/tmp/tr-test-ws" onNavigate={() => {}} onClose={() => {}} onHeaderPointerDown={() => {}} />)
    })
  }

  it('sends fitted phone and tablet viewports and null dimensions for Desktop', async () => {
    await mountBrowser()
    expect(invokeMock).toHaveBeenCalledWith('browser_set_device', { id: LEAF_ID, width: null, height: null, zoom: 1 })
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Phone 393 × 852"]')!.click() })
    expect(invokeMock).toHaveBeenCalledWith('browser_set_device', { id: LEAF_ID, width: 393, height: 852, zoom: 212 / 393 })
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Tablet 820 × 1180"]')!.click() })
    expect(invokeMock).toHaveBeenCalledWith('browser_set_device', { id: LEAF_ID, width: 820, height: 1180, zoom: 430 / 1180 })
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Desktop"]')!.click() })
    expect(invokeMock.mock.calls.filter(([command]) => command === 'browser_set_device').at(-1)?.[1]).toEqual({ id: LEAF_ID, width: null, height: null, zoom: 1 })
    vi.restoreAllMocks()
  })

  it.each(['unknown command browser_set_device', 'browser_set_device is unsupported on macOS'])('disables presets and retains the host refusal: %s', async (refusal) => {
    const implementation = invokeMock.getMockImplementation()!
    invokeMock.mockImplementation((command, args) => command === 'browser_set_device' ? Promise.reject(refusal) : implementation(command, args))
    await mountBrowser()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Phone 393 × 852"]')!.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Tablet 820 × 1180"]')!.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Desktop"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(container.innerHTML).toContain(refusal)
    vi.restoreAllMocks()
  })
})
