// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
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

describe('TerminalPane resize-exhaustion recovery', () => {
  let container: HTMLDivElement
  let root: Root
  let resizeSession: ReturnType<typeof vi.fn>
  let fakeClient: HoustonClient
  let capturedSink: OutputSink | null

  beforeEach(() => {
    vi.useFakeTimers()
    ghosttyMock.reset()
    resizeSession = vi.fn()
    fakeClient = {
      resizeSession,
      attachSession: vi.fn(),
      sessionVisibility: vi.fn(),
      sendStdin: vi.fn()
    } as unknown as HoustonClient
    capturedSink = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  const render = async (fontSize: number, state: SessionInfo['state'] = 'running'): Promise<void> => {
    const registerOutput: RegisterOutput = (_id, sink) => {
      capturedSink = sink
      return () => {
        capturedSink = null
      }
    }
    act(() => {
      root.render(
        <TerminalPane
          client={fakeClient}
          info={{ ...makeSession(), state }}
          theme="warm-espresso"
          active={true}
          connected={true}
          fontSize={fontSize}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          registerOutput={registerOutput}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  it.each(['exited', 'killed', 'interrupted'] as const)('renders %s scrollback without stdin, resize, focus or notices', async (state) => {
    await render(13, state)
    expect(fakeClient.attachSession).toHaveBeenCalled()
    expect(resizeSession).not.toHaveBeenCalled()
    act(() => {
      ghosttyMock.emitData('hello')
      ghosttyMock.emitKey(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))
      ghosttyMock.emitResize(90, 30)
    })
    expect(fakeClient.sendStdin).not.toHaveBeenCalled()
    expect(ghosttyMock.focusSpy).not.toHaveBeenCalled()
    expect(ghosttyMock.createOptions?.readOnly).toBe(true)
    expect(container.querySelector('[data-typeable]')).toBeNull()
    expect(container.textContent).not.toContain('failed')
  })
  it('stops delivery when a mounted live child settles', async () => {
    await render(13)
    resizeSession.mockClear()
    await render(14, 'exited')
    act(() => { ghosttyMock.emitData('x'); ghosttyMock.emitResize(100, 40) })
    expect(fakeClient.sendStdin).not.toHaveBeenCalled()
    expect(resizeSession).not.toHaveBeenCalled()
  })

  it('without the exhaustion signal, a re-triggered syncSize landing on the same size stays deduped (baseline)', async () => {
    await render(13)
    expect(resizeSession).toHaveBeenCalledTimes(1)
    resizeSession.mockClear()

    await render(14)
    expect(resizeSession).not.toHaveBeenCalled()
  })

  it('after four mismatched resize acks exhaust the ladder, the pane re-measures and re-sends the SAME dims', async () => {
    await render(13)
    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 80, 24)
    resizeSession.mockClear()

    expect(capturedSink).not.toBeNull()
    capturedSink!.resizeExhausted()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(resizeSession).toHaveBeenCalledTimes(1)
    expect(resizeSession).toHaveBeenLastCalledWith(1, 80, 24)
  })

  it('does not reassert a second time when the same size exhausts again', async () => {
    await render(13)
    resizeSession.mockClear()

    capturedSink!.resizeExhausted()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(resizeSession).toHaveBeenCalledTimes(1)
    resizeSession.mockClear()

    capturedSink!.resizeExhausted()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(resizeSession).not.toHaveBeenCalled()
  })

  it('does not reassert after unmount', async () => {
    await render(13)
    resizeSession.mockClear()

    capturedSink!.resizeExhausted()
    act(() => root.unmount())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(resizeSession).not.toHaveBeenCalled()
  })
})
