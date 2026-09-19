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

describe('TerminalPane hidden-by-expand resize handling (P2 #8)', () => {
  let container: HTMLDivElement
  let root: Root
  let resizeSession: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient

  beforeEach(() => {
    mockWidth = 400
    mockHeight = 300
    ghosttyMock.cols = 80
    ghosttyMock.rowCount = 24
    ghosttyMock.reset()
    resizeSession = vi.fn()
    fakeClient = {
      resizeSession,
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

  const render = async (hidden: boolean): Promise<void> => {
    act(() => {
      root.render(
        <StrictMode>
          <ExpandedContext.Provider value={hidden ? 999 : null}>
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

  it('does not fire the catch-up refit on mount, hidden or not', async () => {
    await render(false)
    const visibleMountCalls = resizeSession.mock.calls.length

    act(() => root.unmount())
    resizeSession.mockClear()
    root = createRoot(container)
    await render(true)
    expect(resizeSession).toHaveBeenCalledTimes(visibleMountCalls)
  })

  it('dedupes the mount call: fontSize effect does not re-send an unchanged size', async () => {
    await render(false)
    expect(resizeSession).toHaveBeenCalledTimes(1)
  })

  it('fires the catch-up refit exactly once on the hidden->visible transition, and not on hidden->hidden or visible->hidden', async () => {
    await render(false)
    resizeSession.mockClear()

    await render(true)
    expect(resizeSession).not.toHaveBeenCalled()

    await render(true)
    expect(resizeSession).not.toHaveBeenCalled()

    ghosttyMock.cols = 100
    ghosttyMock.rowCount = 30
    await render(false)
    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 100, 30)

    resizeSession.mockClear()
    await render(false)
    expect(resizeSession).not.toHaveBeenCalled()
  })

  it('never forwards a resize through the catch-up refit while the host is zero-size', async () => {
    await render(false)
    resizeSession.mockClear()

    await render(true)
    mockWidth = 0
    mockHeight = 0
    await render(false)

    expect(resizeSession).not.toHaveBeenCalled()
  })

  it('refits through the same syncSize path used at mount, not a second one', async () => {
    await render(false)
    resizeSession.mockClear()
    ghosttyMock.fitSpy.mockClear()

    await render(true)
    ghosttyMock.cols = 120
    ghosttyMock.rowCount = 40
    await render(false)

    expect(ghosttyMock.fitSpy).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenCalledTimes(1)
  })

  it('does not re-send resizeSession when the catch-up recomputes an unchanged size', async () => {
    await render(false)
    resizeSession.mockClear()

    await render(true)
    await render(false)

    expect(resizeSession).not.toHaveBeenCalled()
  })
})
