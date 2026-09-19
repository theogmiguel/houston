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

const { resetSpy, writeSpy } = ghosttyMock

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const { TerminalPane } = await import('./TerminalPane')
const { HoustonClient } = await import('../houston/client')

const FRAME_OUTPUT = 1
const FRAME_OUTPUT_HEADER_LEN = 13
const FRAME_GAP = 3
const FRAME_GAP_LEN = 21

function encodeOutputFrame(session: number, offset: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_OUTPUT_HEADER_LEN + payload.byteLength)
  const view = new DataView(buf)
  view.setUint8(0, FRAME_OUTPUT)
  view.setUint32(1, session, false)
  view.setUint32(5, Math.floor(offset / 4294967296), false)
  view.setUint32(9, offset % 4294967296, false)
  new Uint8Array(buf, FRAME_OUTPUT_HEADER_LEN).set(payload)
  return buf
}

function encodeGapFrame(session: number, bytesSeen: number, dropped: number): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_GAP_LEN)
  const view = new DataView(buf)
  view.setUint8(0, FRAME_GAP)
  view.setUint32(1, session, false)
  view.setUint32(5, Math.floor(bytesSeen / 4294967296), false)
  view.setUint32(9, bytesSeen % 4294967296, false)
  view.setUint32(13, Math.floor(dropped / 4294967296), false)
  view.setUint32(17, dropped % 4294967296, false)
  return buf
}

function scrollbackReply(
  session: number,
  bytesSeen: number,
  generation: number,
  attempt: number
): {
  type: string
  session: number
  data: string
  generation: number
  attempt: number
  replayed_bytes: number
  bytes_seen: number
} {
  return {
    type: 'scrollback',
    session,
    data: '',
    generation,
    attempt,
    replayed_bytes: 0,
    bytes_seen: bytesSeen
  }
}

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

function sentAttachCount(ws: MockWebSocket): number {
  return ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_attach')
    .length
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

describe('TerminalPane gap resync', () => {
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

  it('a kind-3 frame at the transport boundary resets the terminal, re-issues attach, and resets sequencing (buffers a live frame until the fresh replay lands)', async () => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
    ;(window as unknown as { houston: { getConfig: () => Promise<unknown> } }).houston = {
      getConfig: vi.fn().mockResolvedValue({ port: 0, token: 'test-token' })
    }
    const client = await HoustonClient.connect()
    const ws = (client as unknown as { ws: MockWebSocket }).ws

    const outputHandlers = new Map<number, OutputSink>()
    const registerOutput: RegisterOutput = (id, sink) => {
      outputHandlers.set(id, sink)
      return () => outputHandlers.delete(id)
    }
    client.onFrame = (session, offset, payload) =>
      outputHandlers.get(session)?.frame(offset, payload)
    client.onReplay = (session, data, bytesSeen) =>
      outputHandlers.get(session)?.replay(data, bytesSeen)
    client.onGap = (session) => outputHandlers.get(session)?.gap()

    act(() => {
      root.render(
        <TerminalPane
          client={client}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
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

    expect(sentAttachCount(ws)).toBe(1)
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(scrollbackReply(1, 0, 1, 1)) })
    })
    expect(resetSpy).not.toHaveBeenCalled()

    act(() => {
      ws.onmessage?.({ data: encodeGapFrame(1, 500, 128) })
    })

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(sentAttachCount(ws)).toBe(2)

    const writeCallsBeforeReplay = writeSpy.mock.calls.length
    act(() => {
      ws.onmessage?.({ data: encodeOutputFrame(1, 500, new Uint8Array([1, 2, 3])) })
    })
    expect(writeSpy.mock.calls.length).toBe(writeCallsBeforeReplay)

    act(() => {
      ws.onmessage?.({ data: JSON.stringify(scrollbackReply(1, 500, 2, 2)) })
    })
    expect(writeSpy.mock.calls.length).toBeGreaterThan(writeCallsBeforeReplay)
  })

  it('back-to-back gap episodes before the resync replay lands collapse into exactly one reset and one attach (item 10b fix round, in-flight-resync supersession guard)', async () => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
    ;(window as unknown as { houston: { getConfig: () => Promise<unknown> } }).houston = {
      getConfig: vi.fn().mockResolvedValue({ port: 0, token: 'test-token' })
    }
    const client = await HoustonClient.connect()
    const ws = (client as unknown as { ws: MockWebSocket }).ws

    const outputHandlers = new Map<number, OutputSink>()
    const registerOutput: RegisterOutput = (id, sink) => {
      outputHandlers.set(id, sink)
      return () => outputHandlers.delete(id)
    }
    client.onFrame = (session, offset, payload) =>
      outputHandlers.get(session)?.frame(offset, payload)
    client.onReplay = (session, data, bytesSeen) =>
      outputHandlers.get(session)?.replay(data, bytesSeen)
    client.onGap = (session) => outputHandlers.get(session)?.gap()

    act(() => {
      root.render(
        <TerminalPane
          client={client}
          info={makeSession()}
          theme="warm-espresso"
          active={false}
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

    expect(sentAttachCount(ws)).toBe(1)
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(scrollbackReply(1, 0, 1, 1)) })
    })
    expect(resetSpy).not.toHaveBeenCalled()

    act(() => {
      ws.onmessage?.({ data: encodeGapFrame(1, 500, 128) })
    })
    act(() => {
      ws.onmessage?.({ data: encodeGapFrame(1, 900, 64) })
    })

    expect(resetSpy).toHaveBeenCalledTimes(1)
    expect(sentAttachCount(ws)).toBe(2)
  })
})
