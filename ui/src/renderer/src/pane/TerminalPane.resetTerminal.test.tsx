// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'
import type { TermActions } from './TerminalPane'
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

describe('TerminalPane "Reset Terminal" action', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let actionsRef: { current: TermActions | null }

  beforeEach(async () => {
    ghosttyMock.reset()
    actionsRef = { current: null }
    fakeClient = {
      resizeSession: vi.fn(),
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
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
              stripBoxGlyphs={false}
              registerOutput={() => () => {}}
              onActivate={() => {}}
              onZoom={() => {}}
              onShellZoom={() => {}}
              onOpenFile={() => {}}
              onOpenDir={() => {}}
              actions={actionsRef}
            />
          </ExpandedContext.Provider>
        </StrictMode>
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

  it('exposes a `reset` member on TermActions distinct from `clear`', () => {
    expect(actionsRef.current).not.toBeNull()
    expect(typeof actionsRef.current!.reset).toBe('function')
    expect(actionsRef.current!.reset).not.toBe(actionsRef.current!.clear)
  })

  it('reset() performs a full VT reset', () => {
    act(() => actionsRef.current!.reset())
    expect(ghosttyMock.resetSpy).toHaveBeenCalledTimes(1)
  })

  it('clear() erases screen and scrollback WITHOUT a VT reset', () => {
    act(() => actionsRef.current!.clear())
    expect(ghosttyMock.resetSpy).not.toHaveBeenCalled()
    expect(ghosttyMock.writes).toContain('\u001b[H\u001b[2J\u001b[3J')
  })

  it('leaves VT modes alone on clear, which is why Reset Terminal exists', () => {
    ghosttyMock.alternateScreen = true
    act(() => actionsRef.current!.clear())
    expect(ghosttyMock.alternateScreen).toBe(true)
    expect(ghosttyMock.resetSpy).not.toHaveBeenCalled()
  })
})
