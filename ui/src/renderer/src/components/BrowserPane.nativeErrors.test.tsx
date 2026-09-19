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
const { __resetNativeSuppressionForTests, setSuppressionSink } = await import(
  '../layout/nativeSuppression'
)
const { __resetBrowserSurfaceRegistryForTests } = await import('../houston/browserSurfaceRegistry')

const RECT = { x: 0, y: 0, width: 400, height: 300 }
const LEAF_ID = 'b-errors'
const RUST_REFUSAL = `browser: close() on "tr-browser-${LEAF_ID}" (id "${LEAF_ID}"): window gone`

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
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  container.remove()
  __resetNativeSuppressionForTests()
  __resetBrowserSurfaceRegistryForTests()
  setSuppressionSink(null)
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('a rejected native browser command is reported (D42)', () => {
  it('names the command, the surface and the Rust refusal when destroy fails', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'browser_mount' || cmd === 'browser_resize') return Promise.resolve(RECT)
      if (cmd === 'browser_destroy') return Promise.reject(new Error(RUST_REFUSAL))
      return Promise.resolve(undefined)
    })
    const onNativeError = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => {
      root.render(
        <BrowserPane
          node={{ kind: 'browser', id: LEAF_ID, url: 'https://example.test/' }}
          workspaceDir="/tmp/tr-test-ws"
          onNavigate={() => {}}
          onClose={() => {}}
          onHeaderPointerDown={() => {}}
          onNativeError={onNativeError}
        />
      )
    })
    await flush()

    act(() => root.unmount())
    await flush()

    expect(onNativeError).toHaveBeenCalledTimes(1)
    const text = onNativeError.mock.calls[0][0] as string
    expect(text).toContain('destroy')
    expect(text).toContain(LEAF_ID)
    expect(text).toContain(RUST_REFUSAL)
    expect(consoleError).toHaveBeenCalledWith(text)
  })

  it('reports a failed mount the same way, without the handler being required', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'browser_mount') return Promise.reject(new Error('browser: no window labelled "main"'))
      return Promise.resolve(undefined)
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4200))
    })

    const said = consoleError.mock.calls.map((c) => String(c[0]))
    expect(said.some((t) => t.includes('mount') && t.includes(LEAF_ID))).toBe(true)
    act(() => root.unmount())
  }, 10000)
})
