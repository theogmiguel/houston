// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import { GridHiddenContext } from '../layout/gridHiddenContext'
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

describe('TerminalPane grid-hidden resize handling (P4 #23)', () => {
  let container: HTMLDivElement
  let root: Root
  let resizeSession: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient

  beforeEach(() => {
    ghosttyMock.reset()
    mockWidth = 400
    mockHeight = 300
    ghosttyMock.cols = 80
    ghosttyMock.rowCount = 24
    ghosttyMock.createCount = 0
    ghosttyMock.disposeSpy.mock.calls.length = 0
    ghosttyMock.fitSpy.mockClear()
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

  const renderPane = async (
    gridHidden: boolean,
    expandedId: number | null,
    strict: boolean
  ): Promise<void> => {
    const tree = (
      <ExpandedContext.Provider value={expandedId}>
        <GridHiddenContext.Provider value={gridHidden}>
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
        </GridHiddenContext.Provider>
      </ExpandedContext.Provider>
    )
    act(() => {
      root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  it('never unmounts/remounts the pane across a Settings open/close round trip', async () => {
    await renderPane(false, null, false)
    expect(ghosttyMock.createCount).toBe(1)

    await renderPane(true, null, false)
    expect(ghosttyMock.createCount).toBe(1)
    expect(ghosttyMock.disposeSpy.mock.calls.length).toBe(0)

    await renderPane(false, null, false)
    expect(ghosttyMock.createCount).toBe(1)
    expect(ghosttyMock.disposeSpy.mock.calls.length).toBe(0)
  })

  it('fires the catch-up refit exactly once on gridHidden true->false, and forwards the new size to the daemon', async () => {
    await renderPane(false, null, true)
    resizeSession.mockClear()

    await renderPane(true, null, true)
    expect(resizeSession).not.toHaveBeenCalled()

    ghosttyMock.cols = 100
    ghosttyMock.rowCount = 30
    await renderPane(false, null, true)

    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 100, 30)
  })

  it('hides (and catches up) the expanded pane too when gridHidden is true', async () => {
    await renderPane(false, 1, true)
    resizeSession.mockClear()

    await renderPane(true, 1, true)
    expect(resizeSession).not.toHaveBeenCalled()

    ghosttyMock.cols = 120
    ghosttyMock.rowCount = 40
    await renderPane(false, 1, true)

    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 120, 40)
  })

})
