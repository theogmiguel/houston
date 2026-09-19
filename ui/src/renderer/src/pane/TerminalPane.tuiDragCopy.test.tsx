// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => 400
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => 300
})
HTMLElement.prototype.getBoundingClientRect = vi.fn(
  () =>
    ({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }) as DOMRect
)

const { TerminalPane } = await import('./TerminalPane')

function makeSession(): SessionInfo {
  return {
    id: 1,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

function dispatchMouse(target: EventTarget, type: string, opts: MouseEventInit): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...opts }))
}

describe('TerminalPane copy-from-TUI via forced drag tracking (Q9)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let writeText: ReturnType<typeof vi.fn>
  let onActivate: () => void

  async function render(overrides: { stripBoxGlyphs?: boolean } = {}): Promise<HTMLDivElement> {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={null}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
              connected={true}
              fontSize={13}
              copyOnSelect={false}
              stripBoxGlyphs={overrides.stripBoxGlyphs ?? true}
              registerOutput={() => () => {}}
              onActivate={onActivate}
              onZoom={() => {}}
              onShellZoom={() => {}}
              onOpenFile={() => {}}
              onOpenDir={() => {}}
            />
          </ExpandedContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
    const host = container.querySelector('.term-host')
    return host as HTMLDivElement
  }

  beforeEach(() => {
    ghosttyMock.reset()
    ghosttyMock.cols = 10
    ghosttyMock.rowCount = 5
    writeText = vi.fn().mockResolvedValue(undefined)
    onActivate = vi.fn(() => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    })
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reconstructs and copies the dragged range when Ctrl+Shift+drag hits a mouse-tracking alt-screen TUI', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789', 'abcdefghij']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 25,
        clientY: 5
      })
      dispatchMouse(window, 'mousemove', {
        ctrlKey: true,
        shiftKey: true,
        clientX: 45,
        clientY: 15
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 45, clientY: 15 })
    })
    expect(writeText).toHaveBeenCalledWith('23456789\nabcde')
  })

  it('shows the empty-drag hint and never writes the clipboard on a no-movement Ctrl+Shift+drag', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['          ']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 5, clientY: 5 })
    })
    expect(writeText).not.toHaveBeenCalled()
    expect(container.textContent).toContain('No selection — hold Shift and drag')
  })

  it('does nothing when mouse tracking is off (a plain Ctrl+Shift+drag on a normal-buffer shell)', async () => {
    ghosttyMock.mouseTracking = false
    ghosttyMock.alternateScreen = false
    ghosttyMock.gridRows = ['0123456789']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', {
        ctrlKey: true,
        shiftKey: true,
        clientX: 45,
        clientY: 5
      })
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does nothing without Ctrl held, even over a mouse-tracking TUI', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', { button: 0, ctrlKey: false, clientX: 5, clientY: 5 })
      dispatchMouse(window, 'mouseup', { ctrlKey: false, clientX: 45, clientY: 5 })
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('no longer copies on a plain Ctrl+drag (no Shift) over a mouse-tracking alt-screen TUI', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789', 'abcdefghij']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', { button: 0, ctrlKey: true, clientX: 25, clientY: 5 })
      dispatchMouse(window, 'mousemove', { ctrlKey: true, clientX: 45, clientY: 15 })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, clientX: 45, clientY: 15 })
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('lets a plain Ctrl+click through to the grid canvas, but still swallows Ctrl+Shift', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789']
    const host = await render()
    const screenEl = host.querySelector('[data-testid="ghostty-canvas"]') as HTMLElement
    const screenMouseDown = vi.fn()
    screenEl.addEventListener('mousedown', screenMouseDown)

    act(() => {
      dispatchMouse(screenEl, 'mousedown', { button: 0, ctrlKey: true, clientX: 5, clientY: 5 })
    })
    expect(screenMouseDown).toHaveBeenCalledTimes(1)

    screenMouseDown.mockClear()
    act(() => {
      dispatchMouse(screenEl, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 5, clientY: 5 })
    })
    expect(screenMouseDown).not.toHaveBeenCalled()
  })

  it('maps drag coordinates against the canvas rect, not the padded host rect', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789', 'abcdefghij']
    const host = await render()
    const screenEl = host.querySelector('[data-testid="ghostty-canvas"]') as HTMLElement
    host.getBoundingClientRect = vi.fn(
      () => ({ left: 0, top: 0, width: 114, height: 60, right: 114, bottom: 60 }) as DOMRect
    )
    screenEl.getBoundingClientRect = vi.fn(
      () => ({ left: 8, top: 6, width: 100, height: 50, right: 108, bottom: 56 }) as DOMRect
    )
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 37,
        clientY: 10
      })
      dispatchMouse(window, 'mousemove', {
        ctrlKey: true,
        shiftKey: true,
        clientX: 50,
        clientY: 20
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 50, clientY: 20 })
    })
    expect(writeText).toHaveBeenCalledWith('23456789\nabcde')
  })

  it('activates the pane on a gated Ctrl+Shift+drag even though the mousedown never bubbles', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['0123456789']
    const host = await render()
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 45, clientY: 5 })
    })
    expect(onActivate).toHaveBeenCalled()
  })

  it('honors the stripBoxGlyphs setting end-to-end for a dragged range with box-drawing glyphs', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['│ boxed │']
    const host = await render({ stripBoxGlyphs: false })
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 85, clientY: 5 })
    })
    expect(writeText).toHaveBeenCalledWith('│ boxed │')
  })

  it('strips box-drawing glyphs from a dragged range when the setting is on', async () => {
    ghosttyMock.mouseTracking = true
    ghosttyMock.alternateScreen = true
    ghosttyMock.gridRows = ['│ boxed │']
    const host = await render({ stripBoxGlyphs: true })
    act(() => {
      dispatchMouse(host, 'mousedown', {
        button: 0,
        ctrlKey: true,
        shiftKey: true,
        clientX: 5,
        clientY: 5
      })
      dispatchMouse(window, 'mouseup', { ctrlKey: true, shiftKey: true, clientX: 85, clientY: 5 })
    })
    expect(writeText).toHaveBeenCalledWith('boxed')
  })
})
