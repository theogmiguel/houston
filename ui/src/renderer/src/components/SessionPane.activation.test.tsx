// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { SessionPane } from './SessionPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})

;(window as unknown as { houston: Partial<Window['houston']> }).houston = {
  listShells: vi.fn().mockResolvedValue([]),
  pathKind: vi.fn().mockResolvedValue(null),
  openPath: vi.fn().mockResolvedValue({ ok: true })
}

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'claude',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

describe('pane activation on body pointerdown', () => {
  let container: HTMLDivElement
  let root: Root
  let onActivate: ReturnType<typeof vi.fn<(id: number) => void>>

  beforeEach(async () => {
    ghosttyMock.reset()
    onActivate = vi.fn<(id: number) => void>()
    const fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn(),
      respawnSession: vi.fn(),
      closeSession: vi.fn(),
      sessionCwd: vi.fn().mockResolvedValue('/tmp/project')
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        <SessionPane
          client={fakeClient}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={false}
          showProject={false}
          registerOutput={() => () => {}}
          shellIntegration={false}
          onReconnectSsh={() => {}}
          onActivate={onActivate}
          onExpand={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onSplit={() => {}}
          onHeaderPointerDown={() => {}}
          onHandoff={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function mountReportingCanvas(): HTMLCanvasElement {
    const host = container.querySelector('.term-host')
    if (!(host instanceof HTMLElement)) throw new Error('no .term-host rendered')
    const canvas = document.createElement('canvas')
    host.appendChild(canvas)
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    return canvas
  }

  it('activates even when the surface stopPropagation()s the press (mouse-tracking app)', () => {
    const canvas = mountReportingCanvas()
    act(() => {
      canvas.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })
      )
    })
    expect(onActivate).toHaveBeenCalledWith(1)
  })

  it('activates on a plain body press (no mouse tracking)', () => {
    const host = container.querySelector('.term-host')
    if (!(host instanceof HTMLElement)) throw new Error('no .term-host rendered')
    act(() => {
      host.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })
      )
    })
    expect(onActivate).toHaveBeenCalledWith(1)
  })
})
