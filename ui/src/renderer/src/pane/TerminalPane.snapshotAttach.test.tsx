// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
import {
  flushGhosttyAttach,
  ghosttyMock,
  ghosttySurfaceMockModule
} from '../test/ghosttySurfaceMock'

vi.mock('../ghostty/surface', () => ghosttySurfaceMockModule())

const { resetSpy } = ghosttyMock

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const { HoustonClient } = await import('../houston/client')

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  binaryType = ''
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN
      this.onopen?.()
    })
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
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

function snapshotReply(
  session: number,
  outputOffset: number,
  attempt: number,
  state = 'SFZUUw=='
): Record<string, unknown> {
  return {
    type: 'attach_snapshot',
    session,
    generation: 1,
    attempt,
    output_offset: outputOffset,
    format_version: 1,
    state
  }
}

interface Harness {
  ws: MockWebSocket
  sinks: Map<number, OutputSink>
}

describe('TerminalPane snapshot attach', () => {
  let container: HTMLDivElement
  let root: Root

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

  async function mount(options: {
    snapshotAttach: boolean
    daemonFormatVersion?: number
    active?: boolean
  }): Promise<Harness> {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
    ;(window as unknown as { houston: { getConfig: () => Promise<unknown> } }).houston = {
      getConfig: vi.fn().mockResolvedValue({ port: 0, token: 'test-token' })
    }
    const client = await HoustonClient.connect()
    const ws = (client as unknown as { ws: MockWebSocket }).ws
    client.snapshotAttach = options.snapshotAttach
    client.snapshotFormatVersion = options.daemonFormatVersion ?? 1

    const sinks = new Map<number, OutputSink>()
    const registerOutput: RegisterOutput = (id, sink) => {
      sinks.set(id, sink)
      return () => sinks.delete(id)
    }
    client.onFrame = (session, offset, payload) => sinks.get(session)?.frame(offset, payload)
    client.onReplay = (session, data, bytesSeen) => sinks.get(session)?.replay(data, bytesSeen)
    client.onSnapshot = (session, state, outputOffset) =>
      sinks.get(session)?.snapshot(state, outputOffset)
    client.onGap = (session) => sinks.get(session)?.gap()

    act(() => {
      root.render(
        <TerminalPane
          client={client}
          info={makeSession()}
          theme="warm-espresso"
          active={options.active ?? false}
          connected={true}
          fontSize={13}
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
    return { ws, sinks }
  }

  function attaches(ws: MockWebSocket): Record<string, unknown>[] {
    return ws.sent
      .filter((m): m is string => typeof m === 'string')
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.type === 'session_attach')
  }

  it('asks for a snapshot when the daemon has an emulator this engine can read', async () => {
    const { ws } = await mount({ snapshotAttach: true })
    expect(attaches(ws).at(-1)?.snapshot).toBe(true)
  })

  it('does not ask when the daemon has no emulator', async () => {
    const { ws } = await mount({ snapshotAttach: false })
    expect(attaches(ws).at(-1)?.snapshot).toBeUndefined()
  })

  it('stops asking once the loaded engine turns out to read a different container version', async () => {
    ghosttyMock.snapshotFormatVersion = 1
    const { ws, sinks } = await mount({ snapshotAttach: true, daemonFormatVersion: 2 })
    ghosttyMock.importSnapshotSucceeds = false
    const before = attaches(ws).length
    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 5, 1)) })
    void sinks
    const after = attaches(ws).slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.snapshot).toBeUndefined()
  })

  it('imports the state and applies only the frames above the cutoff', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true })
    ghosttyMock.writes.length = 0

    sinks.get(1)?.frame(0, new TextEncoder().encode('covered'))
    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 7, 1)) })

    expect(ghosttyMock.importSnapshotSpy).toHaveBeenCalledTimes(1)
    expect(ghosttyMock.writes).toEqual([])

    sinks.get(1)?.frame(7, new TextEncoder().encode('after'))
    expect(ghosttyMock.writes.map((w) => new TextDecoder().decode(w as Uint8Array))).toEqual([
      'after'
    ])
  })

  it('falls back to one byte-replay attach when the engine refuses the container', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true })
    const before = attaches(ws).length
    ghosttyMock.importSnapshotSucceeds = false

    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 99, 1)) })
    void sinks

    expect(resetSpy).toHaveBeenCalled()
    const after = attaches(ws).slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.snapshot).toBeUndefined()
  })

  it('holds keystrokes until the import lands, then delivers them', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true, active: true })
    const stdinFrames = (): unknown[] => ws.sent.filter((m) => typeof m !== 'string')

    ghosttyMock.emitData('x')
    expect(stdinFrames()).toHaveLength(0)

    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) })
    void sinks
    ghosttyMock.emitData('y')
    expect(stdinFrames()).toHaveLength(1)
  })

  it('overflowing the import buffer asks for exactly one fresh snapshot, never a raw flush', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true })
    const before = attaches(ws).length
    ghosttyMock.writes.length = 0

    const chunk = new Uint8Array(256 * 1024)
    for (let i = 0; i < 17; i++) sinks.get(1)?.frame(i * chunk.length, chunk)

    expect(ghosttyMock.writes).toEqual([])
    const after = attaches(ws).slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.snapshot).toBe(true)
  })
})
