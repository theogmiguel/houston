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
