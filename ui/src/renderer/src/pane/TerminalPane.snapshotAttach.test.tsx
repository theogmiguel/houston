// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../houston/client'
import type { OutputSink, RegisterOutput } from './TerminalPane'
import { BRACKETED_NEWLINE } from './shiftEnter'
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
const { GhosttyPaneTerminal } = await import('./ghosttyTerminal')

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

function replayReply(data: string, bytesSeen: number, attempt: number): Record<string, unknown> {
  return {
    type: 'scrollback',
    session: 1,
    generation: 1,
    attempt,
    data: btoa(data),
    replayed_bytes: data.startsWith('\x1b[0m') ? data.length - 4 : data.length,
    bytes_seen: bytesSeen
  }
}

interface Harness {
  ws: MockWebSocket
  sinks: Map<number, OutputSink>
  render: (info: SessionInfo) => void
}

function stdin(ws: MockWebSocket): string[] {
  return ws.sent
    .filter((m): m is ArrayBuffer => typeof m !== 'string')
    .map((m) => new TextDecoder().decode(new Uint8Array(m, 5)))
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
    vi.restoreAllMocks()
    ghosttyMock.writeSpy.mockReset()
    resetSpy.mockReset()
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

    const render = (info: SessionInfo): void => {
      root.render(
        <TerminalPane
          client={client}
          info={info}
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
    }
    act(() => render(makeSession()))
    await act(async () => {
      await flushGhosttyAttach()
    })
    return { ws, sinks, render }
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

  it('holds keystrokes until the import lands, then delivers them in order', async () => {
    const { ws } = await mount({ snapshotAttach: true, active: true })

    ghosttyMock.emitData('a')
    ghosttyMock.emitData('b')
    ghosttyMock.emitKey(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }))
    ghosttyMock.emitData('c')
    expect(stdin(ws)).toEqual([])

    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))
    expect(stdin(ws)).toEqual(['a', 'b', BRACKETED_NEWLINE, 'c'])

    ghosttyMock.emitData('d')
    expect(stdin(ws)).toEqual(['a', 'b', BRACKETED_NEWLINE, 'c', 'd'])
  })

  it('encodes a paste made during the hold after the import, in order with keystrokes', async () => {
    const { ws } = await mount({ snapshotAttach: true, active: true })
    const send = vi.spyOn(ws, 'send')
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], getData: () => 'echo one\necho two' }
    })

    ghosttyMock.emitData('a')
    ghosttyMock.input.dispatchEvent(paste)
    ghosttyMock.emitData('b')
    expect(paste.defaultPrevented).toBe(true)
    expect(ghosttyMock.pasteSpy).not.toHaveBeenCalled()

    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))
    expect(ghosttyMock.pasteSpy.mock.calls).toEqual([['echo one\necho two']])
    expect(stdin(ws)).toEqual(['a', 'b'])
    const pasteOrder = ghosttyMock.pasteSpy.mock.invocationCallOrder[0] ?? 0
    const stdinOrder = send.mock.calls.flatMap((call, i) =>
      typeof call[0] === 'string' ? [] : [send.mock.invocationCallOrder[i] ?? 0]
    )
    expect(ghosttyMock.importSnapshotSpy.mock.invocationCallOrder[0]).toBeLessThan(pasteOrder)
    expect(stdinOrder[0]).toBeLessThan(pasteOrder)
    expect(stdinOrder[1]).toBeGreaterThan(pasteOrder)
  })

  it('drops a terminal reply produced during the hold and sends the ones after it', async () => {
    const { ws } = await mount({ snapshotAttach: true, active: true })
    const { onData } = ghosttyMock.createOptions as { onData: (data: string, reply?: boolean) => void }

    onData('\x1b[1;1R', true)
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))
    expect(stdin(ws)).toEqual([])

    onData('\x1b[5;9R', true)
    expect(stdin(ws)).toEqual(['\x1b[5;9R'])
  })

  it.each(['history', ''])('releases held input in order when the daemon falls back to replay %j', async (history) => {
    const { ws } = await mount({ snapshotAttach: true, active: true })
    ghosttyMock.emitData('x')
    expect(stdin(ws)).toEqual([])
    act(() => ws.onmessage?.({ data: JSON.stringify(replayReply(history, history.length, 1)) }))
    expect(stdin(ws)).toEqual(['x'])
    ghosttyMock.emitData('y')
    expect(stdin(ws)).toEqual(['x', 'y'])
    expect(resetSpy).not.toHaveBeenCalled()
    expect(ghosttyMock.writes.map((data) => new TextDecoder().decode(data as Uint8Array)).join('')).toBe(history)
  })

  it('releases held input when the engine refuses the snapshot and reattaches for a replay', async () => {
    const { ws } = await mount({ snapshotAttach: true, active: true })
    ghosttyMock.importSnapshotSucceeds = false
    ghosttyMock.emitData('x')

    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))

    expect(attaches(ws).at(-1)?.snapshot).toBeUndefined()
    expect(stdin(ws)).toEqual(['x'])
  })

  it('an older replay cannot release input for a newer snapshot attach', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true, active: true })
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))
    act(() => sinks.get(1)?.gap())
    expect(attaches(ws)).toHaveLength(2)
    act(() => ws.onmessage?.({ data: JSON.stringify(replayReply('obsolete', 8, 1)) }))
    ghosttyMock.emitData('x')
    expect(stdin(ws)).toEqual([])
    expect(ghosttyMock.writes).toEqual([])
    act(() => ws.onmessage?.({ data: JSON.stringify(replayReply('current', 7, 2)) }))
    expect(stdin(ws)).toEqual(['x'])
    ghosttyMock.emitData('y')
    expect(stdin(ws)).toEqual(['x', 'y'])
  })

  it('keeps the oldest held entries past the entry limit and logs the overflow once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws } = await mount({ snapshotAttach: true, active: true })
    const typed = Array.from({ length: 1030 }, (_, i) => String.fromCharCode(0x4e00 + i))

    for (const key of typed) ghosttyMock.emitData(key)
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))

    expect(stdin(ws)).toEqual(typed.slice(0, 1024))
    const overflow = warn.mock.calls.filter(([m]) => String(m).includes('attach snapshot was pending'))
    expect(overflow).toHaveLength(1)
    expect(String(overflow[0]?.[0])).toContain('1024 entries and 1024 code units already held; limit 1024 entries')
  })

  it('keeps the held input within the code-unit limit and logs the entry it refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws } = await mount({ snapshotAttach: true, active: true })
    const big = 'a'.repeat(128 * 1024)

    ghosttyMock.emitData(big)
    ghosttyMock.emitData('b')
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))

    expect(stdin(ws)).toEqual([big])
    expect(warn).toHaveBeenCalledWith(
      'houston: session 1 dropped 1 code units of input typed while its attach snapshot was pending: 1 entries and 131072 code units already held; limit 1024 entries and 131072 code units'
    )
  })

  it('drops held input when the pane closes before the snapshot lands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws, sinks } = await mount({ snapshotAttach: true, active: true })
    ghosttyMock.emitData('x')

    act(() => root.unmount())
    root = createRoot(container)
    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) })

    expect(sinks.size).toBe(0)
    expect(stdin(ws)).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      'houston: session 1 dropped 1 held input entries: the pane closed before its attach snapshot landed'
    )
  })

  it('sends nothing held for a session that ended before the snapshot landed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ws, render } = await mount({ snapshotAttach: true, active: true })
    ghosttyMock.emitData('x')

    act(() => render({ ...makeSession(), state: 'exited' } as SessionInfo))
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))

    expect(stdin(ws)).toEqual([])
    expect(warn).toHaveBeenCalledWith('houston: session 1 dropped 1 held input entries: the pane is no longer live')
  })

  it('rebuilds discarded overflow bytes from a capped fallback replay and flushes held frames once', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true, active: true })
    act(() => ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) }))
    let screen = ''
    ghosttyMock.writeSpy.mockImplementation((data) => {
      // Parsing is synchronous; only its completion notification is delayed below.
      screen += typeof data === 'string' ? data : new TextDecoder().decode(data)
    })
    resetSpy.mockImplementation(() => {
      screen = ''
    })
    const write = GhosttyPaneTerminal.prototype.write
    let complete: (() => void) | undefined
    let hold = true
    vi.spyOn(GhosttyPaneTerminal.prototype, 'write').mockImplementation(function (this: InstanceType<typeof GhosttyPaneTerminal>, data, callback) {
      write.call(this, data, () => {
        if (hold) {
          hold = false
          complete = callback
        } else callback?.()
      })
    })
    const history = 'earlier history\n'
    act(() => sinks.get(1)?.frame(0, new TextEncoder().encode(history)))
    await act(async () => {
      await Promise.resolve()
    })
    expect(complete).toBeTypeOf('function')
    const chunk = new Uint8Array(256 * 1024).fill(0x61)
    act(() => {
      for (let i = 0; i < 9; i++) sinks.get(1)?.frame(history.length + i * chunk.length, chunk)
    })
    expect(attaches(ws)).toHaveLength(2)
    expect(screen).toBe(history)
    expect(resetSpy).not.toHaveBeenCalled()
    const bytesSeen = history.length + 9 * chunk.length
    act(() => sinks.get(1)?.frame(bytesSeen, new TextEncoder().encode('after')))
    act(() => ws.onmessage?.({ data: JSON.stringify(replayReply('stale', 5, 1)) }))
    expect(screen).toBe(history)
    expect(resetSpy).not.toHaveBeenCalled()
    // The real daemon prefixes a partial replay with SGR reset, outside bytes_seen.
    const replay = '\x1b[0m' + 'a'.repeat(2 * 1024 * 1024)
    act(() => ws.onmessage?.({ data: JSON.stringify(replayReply(replay, bytesSeen, 2)) }))
    act(() => complete?.())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(screen).toBe(replay + 'after')
    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Earlier history may be unavailable')
    act(() => sinks.get(1)?.frame(bytesSeen + 5, new TextEncoder().encode('next')))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen).toBe(replay + 'afternext')
    ghosttyMock.emitData('y')
    expect(ws.sent.filter((m) => typeof m !== 'string')).toHaveLength(1)
    expect(attaches(ws)).toHaveLength(2)
    act(() => sinks.get(1)?.gap())
    ghosttyMock.emitData('z')
    expect(ws.sent.filter((m) => typeof m !== 'string')).toHaveLength(1)
  })

  it('a pane that falls behind takes one fresh snapshot instead of dropping output, and keeps taking keystrokes', async () => {
    const { ws, sinks } = await mount({ snapshotAttach: true, active: true })
    ws.onmessage?.({ data: JSON.stringify(snapshotReply(1, 0, 1)) })
    const before = attaches(ws).length
    const stdinFrames = (): unknown[] => ws.sent.filter((m) => typeof m !== 'string')
    const stdinBefore = stdinFrames().length
    ghosttyMock.writes.length = 0

    const chunk = new Uint8Array(256 * 1024).fill(0x61)
    for (let i = 0; i < 12; i++) sinks.get(1)?.frame(i * chunk.length, chunk)

    const after = attaches(ws).slice(before)
    expect(after).toHaveLength(1)
    expect(after[0]?.snapshot).toBe(true)
    ghosttyMock.emitData('\x03')
    expect(stdinFrames()).toHaveLength(stdinBefore + 1)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const written = ghosttyMock.writes
      .map((w) => (typeof w === 'string' ? w : new TextDecoder().decode(w)))
      .join('')
    expect(written).not.toContain('dropped')
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
