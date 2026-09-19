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
const LEAF_ID = 'b-fresh'

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })
}

function renderPane(url: string): void {
  act(() => {
    root.render(
      <BrowserPane
        node={{ kind: 'browser', id: LEAF_ID, url }}
        workspaceDir="/tmp/tr-test-ws"
        onNavigate={() => {}}
        onClose={() => {}}
        onHeaderPointerDown={() => {}}
      />
    )
  })
}

describe('a newly-created browser pane opens on the fresh state (M8)', () => {
  it('mounts no native child for an empty url', async () => {
    renderPane('')
    await flush()

    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'browser_mount')).toEqual([])
    expect(container.querySelector(`[data-browser-surface-id="${LEAF_ID}"]`)).toBeNull()
  })

  it('shows the new-tab address prompt, not a page it does not have', async () => {
    renderPane('')
    await flush()

    const input = container.querySelector('input')
    expect(input).not.toBeNull()
    expect((input as HTMLInputElement).placeholder).toBe('enter a url to open a new tab')
    expect((input as HTMLInputElement).value).toBe('')
  })

  it('still seeds a persisted pane from its own url (the pre-M8 behaviour)', async () => {
    renderPane('https://example.test/')
    await flush()

    expect(invokeMock).toHaveBeenCalledWith(
      'browser_mount',
      expect.objectContaining({ id: LEAF_ID, url: 'https://example.test/' })
    )
  })
})
