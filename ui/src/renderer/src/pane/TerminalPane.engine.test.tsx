// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, SessionInfo } from '../houston/client'
import { ExpandedContext } from '../layout/expandedContext'

const logSpy = vi.fn()

let surfaceCreateShouldThrow = false
let surfaceCreateCount = 0
let surfaceWrites: (string | Uint8Array)[] = []
let surfaceCreateGate: (() => void) | null = null
const surfaceDisposeSpy = vi.fn()

vi.mock('../ghostty/surface', () => ({
  GhosttyTerminalSurface: {
    create: async () => {
      surfaceCreateCount++
      if (surfaceCreateGate) {
        await new Promise<void>((resolve) => {
          surfaceCreateGate = resolve
        })
      }
      if (surfaceCreateShouldThrow) throw new Error('surface create failed (test)')
      return {
        cols: 80,
        rows: 24,
        input: document.createElement('textarea'),
        write: (data: string | Uint8Array) => surfaceWrites.push(data),
        resetAndWrite: () => {},
        paste: () => {},
        setTheme: () => {},
        setFont: async () => {},
        focus: () => {},
        blur: () => {},
        fit: () => {},
        hasSelection: () => false,
        getSelection: () => '',
        clearSelection: () => {},
        selectAll: () => {},
        getBufferText: () => '',
        scrollToBottom: () => {},
        isAtBottom: () => true,
        bufferRowCount: () => 24,
        withScreenReader: (read: (readRow: (y: number) => string) => unknown) => read(() => ''),
        selectScreenRange: () => {},
        revealScreenRow: () => {},
        currentSnapshot: () => null,
        isAlternateScreen: () => false,
        isMouseTracking: () => false,
        isApplicationCursorKeys: () => false,
        refreshHover: () => {},
        scrollbarState: () => null,
        dispose: surfaceDisposeSpy
      }
    }
  }
}))

vi.mock('../houston/latency', () => ({
  logTerminalTransport: (entry: unknown) => logSpy(entry)
}))

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

function makeSession(id: number): SessionInfo {
  return {
    id,
    agent: 'shell',
    project_dir: '/tmp/project',
    cwd: '/tmp/project',
    state: 'running',
    title: 'session-1',
    hidden: false
  } as SessionInfo
}

let capturedSink: {
  replay: (data: Uint8Array, bytesSeen: number) => void
  frame: (offset: number, data: Uint8Array) => void
} | null = null

function renderPane(sessionId: number, root: Root): void {
  const fakeClient = {
    resizeSession: vi.fn(),
    attachSession: vi.fn(),
    sessionVisibility: vi.fn(),
    sendStdin: vi.fn()
  } as unknown as HoustonClient
  act(() => {
    root.render(
      <ExpandedContext.Provider value={null}>
        <TerminalPane
          client={fakeClient}
          info={makeSession(sessionId)}
          theme="warm-espresso"
          active={false}
          connected={true}
          fontSize={13}
          copyOnSelect={false}
          stripBoxGlyphs={true}
          registerOutput={(_id, sink) => {
            capturedSink = sink
            return () => {}
          }}
          onActivate={() => {}}
          onZoom={() => {}}
          onShellZoom={() => {}}
          onOpenFile={() => {}}
          onOpenDir={() => {}}
        />
      </ExpandedContext.Provider>
    )
  })
}

function resetState(): void {
  localStorage.clear()
  surfaceCreateShouldThrow = false
  surfaceCreateCount = 0
  surfaceWrites = []
  surfaceCreateGate = null
  surfaceDisposeSpy.mockClear()
  capturedSink = null
  logSpy.mockClear()
}

async function settleEngine(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  })
}

describe('TerminalPane ghostty engine', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetState()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('mounts exactly one engine per pane, whatever the retired setting still says', async () => {
    localStorage.setItem('tr-terminal-renderer', 'canvas')
    renderPane(10, root)
    await settleEngine()
    expect(surfaceCreateCount).toBe(1)
  })

  it('feeds PTY bytes to the surface', async () => {
    renderPane(11, root)
    await settleEngine()

    const payload = new TextEncoder().encode('hello\r\n')
    await act(async () => {
      capturedSink!.replay(payload, payload.length)
      await Promise.resolve()
    })

    expect(surfaceWrites.length).toBeGreaterThan(0)
  })

  it('buffers writes that land before the engine attaches, then replays them', async () => {
    surfaceCreateGate = () => {}
    renderPane(12, root)
    await act(async () => {
      await Promise.resolve()
    })

    const payload = new TextEncoder().encode('early bytes\r\n')
    await act(async () => {
      capturedSink!.replay(payload, payload.length)
      await Promise.resolve()
    })
    expect(surfaceWrites).toHaveLength(0)

    const release = surfaceCreateGate as unknown as () => void
    await act(async () => {
      release()
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })

    expect(surfaceWrites.length).toBeGreaterThan(0)
    expect(
      logSpy.mock.calls.some(([e]) =>
        (e as { message: string }).message.includes('ghostty surface attached')
      )
    ).toBe(true)
  })

  it('keeps the write queue pumping after the first frame', async () => {
    renderPane(13, root)
    await settleEngine()

    const first = new TextEncoder().encode('one\r\n')
    await act(async () => {
      capturedSink!.replay(first, first.length)
      await Promise.resolve()
    })
    const afterFirst = surfaceWrites.length
    expect(afterFirst).toBeGreaterThan(0)

    const second = new TextEncoder().encode('two\r\n')
    await act(async () => {
      capturedSink!.frame(first.length, second)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(surfaceWrites.length).toBeGreaterThan(afterFirst)
  })

  it('survives an engine that fails to load: logged, queue drained, pane alive', async () => {
    surfaceCreateShouldThrow = true
    renderPane(14, root)
    await settleEngine()

    const payload = new TextEncoder().encode('nowhere to go\r\n')
    await act(async () => {
      capturedSink!.replay(payload, payload.length)
      await Promise.resolve()
    })

    expect(surfaceWrites).toHaveLength(0)
    expect(
      logSpy.mock.calls.some(([e]) =>
        (e as { message: string }).message.includes('ghostty surface setup failed')
      )
    ).toBe(true)
    expect(container.firstElementChild).not.toBeNull()
  })

  it('disposes the engine on unmount', async () => {
    renderPane(15, root)
    await settleEngine()
    act(() => root.unmount())
    expect(surfaceDisposeSpy).toHaveBeenCalledTimes(1)
    root = createRoot(container)
  })
})
