// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../houston/client'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { LayoutView } = await import('./LayoutView')
const { __resetNativeSuppressionForTests, setSuppressionSink } = await import(
  '../layout/nativeSuppression'
)
const { __resetBrowserSurfaceRegistryForTests } = await import('../houston/browserSurfaceRegistry')

const RECT = { x: 0, y: 0, width: 400, height: 300 }

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
document.elementFromPoint = (() => null) as unknown as typeof document.elementFromPoint

let container: HTMLDivElement
let root: Root

const TREE = {
  kind: 'split' as const,
  dir: 'row' as const,
  weights: [50, 50],
  children: [
    { kind: 'editor' as const, id: 'e-drag', path: '/tmp/project/a.ts' },
    { kind: 'browser' as const, id: 'b-target', url: 'https://b.test/' }
  ]
}

function renderGrid(): void {
  act(() => {
    root.render(
      <LayoutView
        tree={TREE}
        sessions={new Map()}
        viewAll={false}
        client={{} as HoustonClient}
        theme="warm-espresso"
        fontSize={13}
        copyOnSelect={false}
        stripBoxGlyphs={false}
        activeId={null}
        connected={true}
        expandedId={null}
        registerOutput={() => () => {}}
        shellIntegration={false}
        workspaceDir="/tmp/project"
        onReconnectSsh={() => {}}
        onActivate={() => {}}
        onExpand={() => {}}
        onZoom={() => {}}
        onShellZoom={() => {}}
        onSplit={() => {}}
        onMove={() => {}}
        onSwap={() => {}}
        onResize={() => {}}
        onCloseBrowser={() => {}}
        onBrowserNavigate={() => {}}
        onCloseEditor={() => {}}
        onSplitEditor={() => {}}
        onHandoff={() => {}}
        onOpenFile={() => {}}
        onOpenDir={() => {}}
      />
    )
  })
}

function visibilityCalls(id: string): boolean[] {
  return invokeMock.mock.calls
    .filter(([cmd, args]) => cmd === 'browser_set_visible' && args?.id === id)
    .map(([, args]) => args.visible as boolean)
}

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
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeAll(async () => {
  await import('./BrowserPane')
})

describe('dragging a pane in a grid that holds browser panes (M8 follow-up)', () => {
  it('hides every browser child while a drag is in flight, not only the drop target', async () => {
    renderGrid()
    await flush()
    invokeMock.mockClear()

    const head = container.querySelector('[data-panekey="e-drag"] .pane-head')
    if (!(head instanceof HTMLElement)) throw new Error('no draggable pane header rendered')

    act(() => {
      head.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 10 }))
    })
    await flush()

    expect(visibilityCalls('b-target').at(-1)).toBe(false)

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, clientY: 10 }))
    })
    await flush()

    expect(visibilityCalls('b-target').at(-1)).toBe(true)
  })
})
