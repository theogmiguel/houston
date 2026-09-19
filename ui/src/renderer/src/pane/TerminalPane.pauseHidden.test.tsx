// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { OutputSink } from './TerminalPane'
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

describe('TerminalPane pauses a hidden pane’s render loop (perf map S2)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  let sink: OutputSink | null = null

  beforeEach(() => {
    ghosttyMock.reset()
    sink = null
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
              registerOutput={(_id, s) => {
                sink = s
                return () => {}
              }}
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

  it('pauses when another pane is expanded and resumes when it is not', async () => {
    await render(false)
    expect(ghosttyMock.setPausedSpy.mock.calls.map(([p]) => p)).not.toContain(true)

    ghosttyMock.setPausedSpy.mockClear()
    await render(true)
    expect(ghosttyMock.setPausedSpy).toHaveBeenCalledWith(true)

    ghosttyMock.setPausedSpy.mockClear()
    await render(false)
    expect(ghosttyMock.setPausedSpy).toHaveBeenCalledWith(false)
  })

  it('keeps feeding the parser while paused — the bytes must not stop', async () => {
    await render(true)
    expect(ghosttyMock.setPausedSpy).toHaveBeenCalledWith(true)

    const before = ghosttyMock.writes.length
    expect(sink).not.toBeNull()
    act(() => {
      sink!.replay(new Uint8Array(0), 0)
      sink!.frame(0, new TextEncoder().encode('hidden output\r\n'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(ghosttyMock.writes.length).toBeGreaterThan(before)
  })

  it('does not close the daemon sink when a pane is merely hidden', async () => {
    await render(false)
    ;(fakeClient.sessionVisibility as unknown as { mockClear: () => void }).mockClear()

    await render(true)

    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()
    expect(ghosttyMock.setPausedSpy).toHaveBeenCalledWith(true)
  })
})
