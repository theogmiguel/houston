// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
import { flushGhosttyAttach, ghosttyMock, ghosttySurfaceMockModule } from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const encoder = new TextEncoder()

function client(): HoustonClient {
  return {
    resizeSession: vi.fn(),
    attachSession: vi.fn(),
    sessionVisibility: vi.fn(),
    sendStdin: vi.fn(),
    notePainted: vi.fn()
  } as unknown as HoustonClient
}

const info: SessionInfo = {
  id: 7,
  agent: 'claude',
  project_dir: '/tmp/project',
  cwd: '/tmp/project',
  title: 'echo pane',
  title_source: 'user',
  hidden: false,
  codename: 'test',
  live_children: 0,
  children_waiting: 0,
  inbox_unread: 0,
  tags: [],
  resumable: true,
  state: 'running',
  status: null,
  restore_deferred: null
}

describe('echo paint timing', () => {
  let container: HTMLDivElement
  let root: Root
  let sink: OutputSink
  const registerOutput: RegisterOutput = (_id, output) => {
    sink = output
    return () => {}
  }

  beforeEach(() => {
    ghosttyMock.reset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function syncedPane(c: HoustonClient): Promise<number> {
    await act(async () => {
      root.render(
        <TerminalPane
          client={c} info={info} active connected
          theme="warm-espresso" fontSize={13} copyOnSelect={false} stripBoxGlyphs={false}
          registerOutput={registerOutput} onActivate={() => {}} onZoom={() => {}}
          onShellZoom={() => {}} onOpenFile={() => {}} onOpenDir={() => {}}
        />
      )
      await flushGhosttyAttach()
    })
    const replay = encoder.encode('prompt> ')
    await act(async () => {
      sink.replay(replay, replay.length)
      await flushGhosttyAttach()
    })
    return replay.length
  }

  function paint(): void {
    const onPaint = ghosttyMock.createOptions?.onPaint as (() => void) | undefined
    expect(onPaint).toBeTypeOf('function')
    onPaint!()
  }

  it('reports a paint once every frame that reached the pane has been parsed', async () => {
    const c = client()
    const offset = await syncedPane(c)
    vi.mocked(c.notePainted).mockClear()

    sink.frame(offset, encoder.encode('a'))
    paint()

    expect(c.notePainted).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('does not report a paint while output is still queued ahead of the engine', async () => {
    vi.useFakeTimers()
    try {
      const c = client()
      const offset = await syncedPane(c)
      vi.mocked(c.notePainted).mockClear()

      // Above the small-write bypass, so the queue holds it for its batch window.
      sink.frame(offset, encoder.encode('x'.repeat(4096)))
      paint()
      expect(c.notePainted).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      paint()
      expect(c.notePainted).toHaveBeenCalledExactlyOnceWith(7)
    } finally {
      vi.useRealTimers()
    }
  })
})
