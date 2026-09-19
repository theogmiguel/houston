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

let mockWidth = 400
let mockHeight = 300
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => mockWidth
})
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => mockHeight
})

const { TerminalPane } = await import('./TerminalPane')

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

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

describe('TerminalPane repaints when the window comes back', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient

  beforeEach(() => {
    vi.useFakeTimers()
    mockWidth = 400
    mockHeight = 300
    setVisibility('visible')
    ghosttyMock.reset()
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
    vi.useRealTimers()
  })

  const render = async (hiddenByExpand = false): Promise<void> => {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={hiddenByExpand ? 999 : null}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
              connected={true}
              fontSize={13}
              copyOnSelect={false}
              stripBoxGlyphs={true}
              registerOutput={() => () => {}}
              onActivate={() => {}}
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
  }

  it('regaining focus repaints every visible pane, three times over the landing frames', async () => {
    await render()
    ghosttyMock.forceRenderSpy.mockClear()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    // The immediate attempt plus the rAF and the two delayed retries, exactly
    // the wake cascade: the frame the return lands on may still be mid-layout.
    expect(ghosttyMock.forceRenderSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('becoming visible repaints; going hidden does not', async () => {
    await render()
    ghosttyMock.forceRenderSpy.mockClear()

    setVisibility('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(ghosttyMock.forceRenderSpy).not.toHaveBeenCalled()

    setVisibility('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(ghosttyMock.forceRenderSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('a pane with no laid-out size (a warm workspace) paints nothing', async () => {
    await render()
    ghosttyMock.forceRenderSpy.mockClear()
    mockWidth = 0
    mockHeight = 0

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(ghosttyMock.forceRenderSpy).not.toHaveBeenCalled()
  })
})
