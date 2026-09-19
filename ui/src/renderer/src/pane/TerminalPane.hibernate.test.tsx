// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { WarmContext } from '../layout/warmContext'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

let calls: string[] = []
const decoder = new TextDecoder()
const writes = {
  join: (sep: string): string =>
    ghosttyMock.writes
      .map((w) => (typeof w === 'string' ? w : decoder.decode(w)))
      .join(sep),
  clear: (): void => {
    ghosttyMock.writes.length = 0
  }
}

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
    id: 7,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-7',
    hidden: false
  } as SessionInfo
}

describe('TerminalPane hibernation (02-grid row 17)', () => {
  let container: HTMLDivElement
  let root: Root
  let fakeClient: HoustonClient
  const sinks = new Map<number, import('./TerminalPane').OutputSink>()

  beforeEach(() => {
    vi.useFakeTimers()
    mockWidth = 400
    mockHeight = 300
    ghosttyMock.cols = 80
    ghosttyMock.rowCount = 24
    calls = []
    ghosttyMock.reset()
    ghosttyMock.fitSpy.mockImplementation(() => calls.push('fit'))
    ghosttyMock.forceRenderSpy.mockImplementation(() => calls.push('refresh'))
    fakeClient = {
      resizeSession: vi.fn((id: number, cols: number, rows: number) => {
        calls.push(`resize:${id}:${cols}x${rows}`)
      }),
      attachSession: vi.fn((id: number) => calls.push(`attach:${id}`)),
      sessionVisibility: vi.fn((id: number, visible: boolean) =>
        calls.push(`visible:${id}:${visible}`)
      ),
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

  const render = async (warm: boolean): Promise<void> => {
    act(() => {
      root.render(
        <StrictMode>
          <WarmContext.Provider value={warm}>
            <TerminalPane
              client={fakeClient}
              info={makeSession()}
              theme="warm-espresso"
              active={false}
              connected={true}
              fontSize={13}
              copyOnSelect={false}
              stripBoxGlyphs={true}
              registerOutput={(id, s) => {
                sinks.set(id, s)
                return () => sinks.delete(id)
              }}
              onActivate={() => {}}
              onZoom={() => {}}
              onShellZoom={() => {}}
              onOpenFile={() => {}}
              onOpenDir={() => {}}
            />
          </WarmContext.Provider>
        </StrictMode>
      )
    })
    await act(async () => {
      await flushGhosttyAttach()
    })
  }

  it('a pane that mounts warm neither subscribes nor replays', async () => {
    await render(true)
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()
    expect(fakeClient.attachSession).not.toHaveBeenCalled()
  })

  it('waking re-measures before it asks for a single frame', async () => {
    await render(true)
    ghosttyMock.cols = 120
    ghosttyMock.rowCount = 40
    calls = []

    await render(false)

    const fitAt = calls.indexOf('fit')
    const visibleAt = calls.indexOf('visible:7:true')
    const attachAt = calls.indexOf('attach:7')
    expect(fitAt).toBeGreaterThanOrEqual(0)
    expect(visibleAt).toBeGreaterThanOrEqual(0)
    expect(attachAt).toBeGreaterThanOrEqual(0)
    expect(fitAt).toBeLessThan(visibleAt)
    expect(visibleAt).toBeLessThan(attachAt)
    expect(calls).toContain('resize:7:120x40')
    expect(calls.indexOf('resize:7:120x40')).toBeLessThan(visibleAt)
  })

  it('waking twice does not subscribe twice', async () => {
    await render(true)
    await render(false)
    ;(fakeClient.attachSession as ReturnType<typeof vi.fn>).mockClear()
    ;(fakeClient.sessionVisibility as ReturnType<typeof vi.fn>).mockClear()

    await render(false)
    expect(fakeClient.attachSession).not.toHaveBeenCalled()
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()
  })

  it('going warm unsubscribes only after the debounce, and flicking back costs nothing', async () => {
    await render(false)
    ;(fakeClient.sessionVisibility as ReturnType<typeof vi.fn>).mockClear()
    ;(fakeClient.attachSession as ReturnType<typeof vi.fn>).mockClear()

    await render(true)
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()

    await render(false)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()
    expect(fakeClient.attachSession).not.toHaveBeenCalled()
  })

  it('going warm and staying warm stops the frames, keeping the instance', async () => {
    await render(false)
    const createsBefore = ghosttyMock.createCount
    const disposesBefore = ghosttyMock.disposeSpy.mock.calls.length
    ;(fakeClient.sessionVisibility as ReturnType<typeof vi.fn>).mockClear()

    await render(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(fakeClient.sessionVisibility).toHaveBeenCalledWith(7, false)
    expect(ghosttyMock.createCount).toBe(createsBefore)
    expect(ghosttyMock.disposeSpy.mock.calls.length).toBe(disposesBefore)
  })

  it('waking a synced pane catches up ONLY the bytes missed while hidden', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('0123456789'.repeat(10)), 100)
    await vi.advanceTimersByTimeAsync(50)
    writes.clear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)
    const ring = 'x'.repeat(10) + 'MISSED-WHILE-HIDDEN'.padEnd(50, '.')
    sink.replay(new TextEncoder().encode(ring), 150)
    await vi.advanceTimersByTimeAsync(50)

    const written = writes.join('')
    expect(written).toBe(ring.slice(10))
    expect(written).not.toContain('x')
  })

  it('waking with nothing missed writes nothing — the instant switch', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)
    writes.clear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)

    expect(writes.join('')).toBe('')
  })

  it('a gap larger than the ring resets and replays instead of silently skipping bytes', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)
    ;(fakeClient.attachSession as ReturnType<typeof vi.fn>).mockClear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)
    sink.replay(new TextEncoder().encode('z'.repeat(100)), 500)
    await vi.advanceTimersByTimeAsync(50)

    expect(fakeClient.attachSession).toHaveBeenCalledTimes(2)
  })

  it('holds a frame that beats the wake replay and writes it in stream order', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)
    writes.clear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)

    sink.frame(150, new TextEncoder().encode('LIVE!'))
    await vi.advanceTimersByTimeAsync(1)
    const ring = 'x'.repeat(10) + 'MISSED-WHILE-HIDDEN'.padEnd(50, '.')
    sink.replay(new TextEncoder().encode(ring), 150)
    await vi.advanceTimersByTimeAsync(50)

    expect(writes.join('')).toBe(ring.slice(10) + 'LIVE!')
  })

  it('does not re-print a raced frame the wake replay already carried', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)
    writes.clear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)

    sink.frame(150, new TextEncoder().encode('LIVE!'))
    await vi.advanceTimersByTimeAsync(1)
    const ring = 'x'.repeat(5) + 'MISSED-WHILE-HIDDEN'.padEnd(50, '.') + 'LIVE!'
    sink.replay(new TextEncoder().encode(ring), 155)
    await vi.advanceTimersByTimeAsync(50)

    const written = writes.join('')
    expect(written).toBe(ring.slice(5))
    expect(written.match(/LIVE!/g)?.length).toBe(1)
  })

  it('resyncs instead of splicing when a live frame skips a byte range', async () => {
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    sink.replay(new TextEncoder().encode('a'.repeat(100)), 100)
    await vi.advanceTimersByTimeAsync(50)
    writes.clear()
    ;(fakeClient.attachSession as ReturnType<typeof vi.fn>).mockClear()

    sink.frame(200, new TextEncoder().encode('SPLICED'))
    await vi.advanceTimersByTimeAsync(50)

    expect(fakeClient.attachSession).toHaveBeenCalledTimes(1)
    expect(writes.join('')).not.toContain('SPLICED')
  })

  it('waking forces a repaint — xterm will not redraw a pane nothing asked to draw', async () => {
    await render(false)
    await render(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    calls = []

    await render(false)
    expect(calls).toContain('refresh')

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(calls.filter((c) => c === 'refresh').length).toBeGreaterThanOrEqual(3)
  })

  it('a pane that mounts awake never repaints — it was never hidden', async () => {
    await render(false)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(calls.filter((c) => c === 'refresh')).toEqual([])
  })

  it('going warm again cancels the repaint still in flight', async () => {
    await render(false)
    await render(true)
    act(() => {
      vi.advanceTimersByTime(250)
    })
    calls = []
    await render(false)
    const painted = calls.filter((c) => c === 'refresh').length
    expect(painted).toBeGreaterThan(0)

    await render(true)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(calls.filter((c) => c === 'refresh').length).toBe(painted)
  })

  const daemonHasAnEmulator = (): void => {
    const c = fakeClient as unknown as {
      snapshotAttach: boolean
      snapshotFormatVersion: number
    }
    c.snapshotAttach = true
    c.snapshotFormatVersion = ghosttyMock.snapshotFormatVersion
  }

  const snapshotAsks = (): unknown[] =>
    (fakeClient.attachSession as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2])

  it('waking a synced pane asks for a byte replay, never a snapshot', async () => {
    daemonHasAnEmulator()
    await render(false)
    const sink = sinks.get(7)!
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshotAsks().at(-1)).toBe(true)
    sink.snapshot(new Uint8Array([1, 2, 3]), 100)
    await vi.advanceTimersByTimeAsync(50)
    ;(fakeClient.attachSession as ReturnType<typeof vi.fn>).mockClear()
    ghosttyMock.importSnapshotSpy.mockClear()
    ghosttyMock.resetSpy.mockClear()
    writes.clear()

    await render(true)
    await vi.advanceTimersByTimeAsync(250)
    await render(false)

    expect(snapshotAsks()).toEqual([undefined])
    expect(ghosttyMock.importSnapshotSpy).not.toHaveBeenCalled()

    const ring = 'x'.repeat(10) + 'MISSED-WHILE-HIDDEN'.padEnd(50, '.')
    sink.replay(new TextEncoder().encode(ring), 150)
    await vi.advanceTimersByTimeAsync(50)

    expect(ghosttyMock.resetSpy).not.toHaveBeenCalled()
    expect(writes.join('')).toBe(ring.slice(10))
  })

  it('waking a pane that never synced still takes the snapshot', async () => {
    daemonHasAnEmulator()
    await render(true)
    expect(fakeClient.attachSession).not.toHaveBeenCalled()

    await render(false)

    expect(snapshotAsks().at(-1)).toBe(true)
  })

  it('unmounting a warm pane that was never woken does not unsubscribe', async () => {
    await render(true)
    ;(fakeClient.sessionVisibility as ReturnType<typeof vi.fn>).mockClear()
    act(() => root.unmount())
    expect(fakeClient.sessionVisibility).not.toHaveBeenCalled()
  })
})
