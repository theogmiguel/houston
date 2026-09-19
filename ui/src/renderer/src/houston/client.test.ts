// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ROUND_TRIP_THRESHOLD_MS } from './latency'
import { CWD_CACHE_TTL_MS, HoustonClient } from './client'
import type { TerminalTransport } from './transport/types'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

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

function getTransport(client: HoustonClient): TerminalTransport {
  return (client as unknown as { terminals: TerminalTransport }).terminals
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

async function connectFakeClient(): Promise<{ client: HoustonClient; ws: MockWebSocket }> {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
  ;(window as unknown as { houston: { getConfig: () => Promise<unknown> } }).houston = {
    getConfig: vi.fn().mockResolvedValue({ port: 0, token: 'test-token', pid: 0, protocol: 34 })
  }
  const client = await HoustonClient.connect()
  const ws = (client as unknown as { ws: MockWebSocket }).ws
  return { client, ws }
}

function trackerState(client: HoustonClient): {
  pending: Map<number, unknown[]>
  lastEmittedMs: Map<string, number>
} {
  return (
    client as unknown as {
      latency: { pending: Map<number, unknown[]>; lastEmittedMs: Map<string, number> }
    }
  ).latency
}

describe('HoustonClient frame dispatch (Finding 2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('closes a pending write-latency mark and delivers the frame via onFrame, driven through the real onmessage handler', async () => {
    const { client, ws } = await connectFakeClient()

    client.sendStdin(7, 'a')
    expect(trackerState(client).pending.get(7)?.length).toBe(1)

    let received: [number, number, Uint8Array] | null = null
    client.onFrame = (session, offset, payload) => {
      received = [session, offset, payload]
    }

    const payload = new Uint8Array([1, 2, 3])
    ws.onmessage?.({ data: encodeOutputFrame(7, 42, payload) })

    expect(trackerState(client).pending.get(7)?.length ?? 0).toBe(0)
    expect(received).toEqual([7, 42, payload])
  })

  it('routes every incoming frame through dispatchFrame() itself, not inlined logic', async () => {
    const { client, ws } = await connectFakeClient()
    const dispatchSpy = vi.spyOn(client, 'dispatchFrame')

    const payload = new Uint8Array([9, 9])
    ws.onmessage?.({ data: encodeOutputFrame(11, 5, payload) })

    expect(dispatchSpy).toHaveBeenCalledExactlyOnceWith(11, 5, payload)
  })

  it('emits a slow-round-trip record for a mark closed via the real onmessage handler', async () => {
    const { client, ws } = await connectFakeClient()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(ROUND_TRIP_THRESHOLD_MS + 50)
      .mockReturnValue(ROUND_TRIP_THRESHOLD_MS + 50)

    client.sendStdin(9, 'a')
    ws.onmessage?.({ data: encodeOutputFrame(9, 0, new Uint8Array()) })

    expect(
      debugSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('slow round trip')
      )
    ).toBe(true)
  })
})

describe('HoustonClient session teardown (Finding 3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('drops both the pending-mark queue and the throttle entries for a removed session', async () => {
    const { client, ws } = await connectFakeClient()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(ROUND_TRIP_THRESHOLD_MS + 50)
      .mockReturnValueOnce(ROUND_TRIP_THRESHOLD_MS + 50)
      .mockReturnValueOnce(301)
      .mockReturnValueOnce(302)
      .mockReturnValue(302)

    client.sendStdin(3, 'a')
    ws.onmessage?.({ data: encodeOutputFrame(3, 0, new Uint8Array()) })
    expect(
      debugSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('slow round trip')
      )
    ).toBe(true)

    client.sendStdin(3, 'b')
    expect(trackerState(client).pending.get(3)?.length).toBe(1)

    let subscriberCalled: unknown = null
    client.subscribeAll((msg) => {
      subscriberCalled = msg
    })
    ws.onmessage?.({ data: JSON.stringify({ type: 'session_removed', session: 3 }) })

    expect(trackerState(client).pending.has(3)).toBe(false)
    const leftoverKeys = [...trackerState(client).lastEmittedMs.keys()].filter((k) =>
      k.startsWith('3:')
    )
    expect(leftoverKeys).toEqual([])
    expect(subscriberCalled).toEqual({ type: 'session_removed', session: 3 })
  })
})

describe('HoustonClient subscribe/subscribeAll dispatch (Phase 6 seam)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers one message to two independent subscribeAll subscribers', async () => {
    const { client, ws } = await connectFakeClient()
    const first: unknown[] = []
    const second: unknown[] = []
    client.subscribeAll((msg) => first.push(msg))
    client.subscribeAll((msg) => second.push(msg))

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })

    expect(first).toEqual([{ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }])
    expect(second).toEqual(first)
  })

  it('delivers only the matching kind to a subscribe() subscriber, narrowed with no cast', async () => {
    const { client, ws } = await connectFakeClient()
    const gitStatusMsgs: Array<{ dir: string }> = []
    client.subscribe('git_status', (msg) => {
      gitStatusMsgs.push({ dir: msg.dir })
    })

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })
    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/project', files: [], branch: 'main' })
    })

    expect(gitStatusMsgs).toEqual([{ dir: '/tmp/project' }])
  })

  it('unsubscribe removes exactly one subscription and is idempotent', async () => {
    const { client, ws } = await connectFakeClient()
    const kept: unknown[] = []
    const removed: unknown[] = []
    client.subscribeAll((msg) => kept.push(msg))
    const unsubscribe = client.subscribeAll((msg) => removed.push(msg))

    unsubscribe()
    unsubscribe()

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })

    expect(kept.length).toBe(1)
    expect(removed.length).toBe(0)
  })

  it('unsubscribing a subscriber from inside its own handler mid-dispatch does not skip or double-deliver to a later subscriber', async () => {
    const { client, ws } = await connectFakeClient()
    const order: string[] = []
    let unsubscribeSelf: (() => void) | null = null
    unsubscribeSelf = client.subscribeAll(() => {
      order.push('self')
      unsubscribeSelf?.()
    })
    client.subscribeAll(() => order.push('later'))

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })
    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })

    expect(order).toEqual(['self', 'later', 'later'])
  })

  it('a throwing subscribeAll subscriber does not prevent a later subscriber from receiving the message', async () => {
    const { client, ws } = await connectFakeClient()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: unknown[] = []
    client.subscribeAll(() => {
      throw new Error('boom — deliberately broken subscriber')
    })
    client.subscribeAll((msg) => received.push(msg))

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })

    expect(received).toEqual([{ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }])
    expect(errorSpy).toHaveBeenCalled()
  })

  it('a throwing subscribe(kind) subscriber does not prevent a later same-kind subscriber from receiving the message (Finding 4)', async () => {
    const { client, ws } = await connectFakeClient()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const received: Array<{ dir: string }> = []
    client.subscribe('git_status', () => {
      throw new Error('boom — deliberately broken kind subscriber')
    })
    client.subscribe('git_status', (msg) => received.push({ dir: msg.dir }))

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/project', files: [], branch: 'main' })
    })

    expect(received).toEqual([{ dir: '/tmp/project' }])
    expect(errorSpy).toHaveBeenCalled()
  })

  it('subscribe(kind) unsubscribe stops delivery to that subscriber (Finding 5)', async () => {
    const { client, ws } = await connectFakeClient()
    const received: Array<{ dir: string }> = []
    const unsubscribe = client.subscribe('git_status', (msg) => received.push({ dir: msg.dir }))

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/project', files: [], branch: 'main' })
    })
    expect(received.length).toBe(1)

    unsubscribe()
    unsubscribe()

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/second', files: [], branch: 'main' })
    })
    expect(received.length).toBe(1)
  })

  it('registering the SAME function reference twice via subscribeAll delivers to it twice; unsubscribing one leaves the other delivering once (Finding 1)', async () => {
    const { client, ws } = await connectFakeClient()
    const calls: unknown[] = []
    const sharedHandler = (msg: unknown): void => {
      calls.push(msg)
    }
    client.subscribeAll(sharedHandler)
    const secondUnsubscribe = client.subscribeAll(sharedHandler)

    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })
    expect(calls.length).toBe(2)

    secondUnsubscribe()
    ws.onmessage?.({ data: JSON.stringify({ type: 'hello_ok', protocol: 1, sessions: [], workspaces: [] }) })
    expect(calls.length).toBe(3)
  })

  it('registering the SAME function reference twice via subscribe(kind) delivers to it twice; unsubscribing one leaves the other delivering once (Finding 1)', async () => {
    const { client, ws } = await connectFakeClient()
    const calls: unknown[] = []
    const sharedHandler = (msg: { dir: string }): void => {
      calls.push(msg)
    }
    client.subscribe('git_status', sharedHandler)
    const secondUnsubscribe = client.subscribe('git_status', sharedHandler)

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/project', files: [], branch: 'main' })
    })
    expect(calls.length).toBe(2)

    secondUnsubscribe()
    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/second', files: [], branch: 'main' })
    })
    expect(calls.length).toBe(3)
  })

  it('a subscribeAll registration made from inside a subscribe(kind) handler does not receive the in-flight message, only the next one (Finding 3)', async () => {
    const { client, ws } = await connectFakeClient()
    const allReceived: unknown[] = []
    client.subscribe('git_status', () => {
      client.subscribeAll((msg) => allReceived.push(msg))
    })

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/project', files: [], branch: 'main' })
    })
    expect(allReceived).toEqual([])

    ws.onmessage?.({
      data: JSON.stringify({ type: 'git_status', dir: '/tmp/second', files: [], branch: 'main' })
    })
    expect(allReceived).toEqual([
      { type: 'git_status', dir: '/tmp/second', files: [], branch: 'main' }
    ])
  })
})

describe('HoustonClient gap resync (item 10b)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the gap through system_log_debug (console.debug) naming session, droppedBytes, bytesSeen — never the daemon-side queue-capacity constant', async () => {
    const { ws } = await connectFakeClient()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    ws.onmessage?.({ data: encodeGapFrame(7, 4096, 512) })

    const gapCall = debugSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].startsWith('[terminal-transport] gap:')
    )
    expect(gapCall).toBeDefined()
    expect(gapCall![1]).toEqual({ session: 7, droppedBytes: 512, bytesSeen: 4096 })
    expect(JSON.stringify(gapCall![1])).not.toContain('144')
  })

  it('routes the decoded gap frame to onGap exactly once, driven through the real onmessage handler', async () => {
    const { client, ws } = await connectFakeClient()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const onGap = vi.fn()
    client.onGap = onGap

    ws.onmessage?.({ data: encodeGapFrame(9, 10, 3) })

    expect(onGap).toHaveBeenCalledExactlyOnceWith(9, 10, 3)
  })
})

describe('HoustonClient resize retry ladder mechanics (item 10b)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a mismatched ack at exactly 100ms, then 300ms, then 800ms, and stops on the first match', async () => {
    const { client } = await connectFakeClient()
    const resizeMock = vi
      .fn()
      .mockResolvedValueOnce({ cols: 100, rows: 30 })
      .mockResolvedValueOnce({ cols: 100, rows: 30 })
      .mockResolvedValueOnce({ cols: 100, rows: 30 })
      .mockResolvedValueOnce({ cols: 80, rows: 24 })
    getTransport(client).resize = resizeMock

    client.resizeSession(1, 80, 24)
    await vi.advanceTimersByTimeAsync(0)
    expect(resizeMock).toHaveBeenCalledTimes(1)
    expect(resizeMock).toHaveBeenNthCalledWith(1, 1, 80, 24)

    await vi.advanceTimersByTimeAsync(99)
    expect(resizeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock).toHaveBeenNthCalledWith(2, 1, 80, 24)

    await vi.advanceTimersByTimeAsync(299)
    expect(resizeMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(resizeMock).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(799)
    expect(resizeMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(resizeMock).toHaveBeenCalledTimes(4)
    expect(resizeMock).toHaveBeenNthCalledWith(4, 1, 80, 24)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(resizeMock).toHaveBeenCalledTimes(4)
  })

  it('sends exactly one session_resize-equivalent call when the ack matches on the first try', async () => {
    const { client } = await connectFakeClient()
    const resizeMock = vi.fn().mockResolvedValueOnce({ cols: 80, rows: 24 })
    getTransport(client).resize = resizeMock

    client.resizeSession(1, 80, 24)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(resizeMock).toHaveBeenCalledTimes(1)
  })

  it('logs exhaustion after the third retry still disagrees, naming requested dims, the last ack, and the session — and does not throw into the caller', async () => {
    const { client } = await connectFakeClient()
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const resizeMock = vi.fn().mockResolvedValue({ cols: 100, rows: 30 })
    getTransport(client).resize = resizeMock

    expect(() => client.resizeSession(1, 80, 24)).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(800)

    expect(resizeMock).toHaveBeenCalledTimes(4)
    const exhaustionCall = debugSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('exhausted')
    )
    expect(exhaustionCall).toBeDefined()
    expect(exhaustionCall![0]).toContain('[terminal-transport]')
    expect(exhaustionCall![0]).toContain('100, 300, 800')
    expect(exhaustionCall![1]).toEqual({
      session: 1,
      requestedCols: 80,
      requestedRows: 24,
      lastAckCols: 100,
      lastAckRows: 30
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(resizeMock).toHaveBeenCalledTimes(4)
  })

  it('a rejected ack (a timeout behind a slow daemon reply) fires the exhaustion signal once, so the pane re-asserts its size', async () => {
    const { client } = await connectFakeClient()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const resizeMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('session_resize ack for session 1 (203x48) timed out after 1500ms'))
    getTransport(client).resize = resizeMock
    const exhausted = vi.fn()
    client.onResizeExhausted = exhausted

    client.resizeSession(1, 203, 48)
    await vi.advanceTimersByTimeAsync(0)

    expect(resizeMock).toHaveBeenCalledTimes(1)
    expect(exhausted).toHaveBeenCalledTimes(1)
    expect(exhausted).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(resizeMock).toHaveBeenCalledTimes(1)
  })

  it('requirement 1: a newer resize for the same session cancels a pending retry timer outright', async () => {
    const { client } = await connectFakeClient()
    const resizeMock = vi.fn().mockResolvedValueOnce({ cols: 100, rows: 30 })
    getTransport(client).resize = resizeMock

    client.resizeSession(1, 80, 24)
    await vi.advanceTimersByTimeAsync(0)
    expect(resizeMock).toHaveBeenCalledTimes(1)

    resizeMock.mockResolvedValueOnce({ cols: 120, rows: 40 })
    client.resizeSession(1, 120, 40)
    await vi.advanceTimersByTimeAsync(0)
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock).toHaveBeenNthCalledWith(2, 1, 120, 40)

    await vi.advanceTimersByTimeAsync(1000)
    expect(resizeMock).toHaveBeenCalledTimes(2)
  })

  it('requirement 1: a newer resize ignores a stale ack from an in-flight (not-yet-resolved) old request — the stale ladder cannot fire', async () => {
    const { client } = await connectFakeClient()
    const resizeMock = vi.fn()
    getTransport(client).resize = resizeMock

    let resolveFirst!: (ack: { cols: number; rows: number }) => void
    resizeMock.mockImplementationOnce(
      () =>
        new Promise<{ cols: number; rows: number }>((resolve) => {
          resolveFirst = resolve
        })
    )
    client.resizeSession(1, 80, 24)
    expect(resizeMock).toHaveBeenCalledTimes(1)

    resizeMock.mockResolvedValueOnce({ cols: 120, rows: 40 })
    client.resizeSession(1, 120, 40)
    await vi.advanceTimersByTimeAsync(0)
    expect(resizeMock).toHaveBeenCalledTimes(2)
    expect(resizeMock).toHaveBeenNthCalledWith(2, 1, 120, 40)

    resolveFirst({ cols: 999, rows: 999 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(resizeMock).toHaveBeenCalledTimes(2)
  })

  it('close() cancels a pending ladder retry timer — no further resize call reaches the transport after close, even past the last rung (item 10b fix round, finding 8)', async () => {
    const { client } = await connectFakeClient()
    const resizeMock = vi.fn().mockResolvedValueOnce({ cols: 100, rows: 30 })
    getTransport(client).resize = resizeMock

    client.resizeSession(1, 80, 24)
    await vi.advanceTimersByTimeAsync(0)
    expect(resizeMock).toHaveBeenCalledTimes(1)

    client.close()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(resizeMock).toHaveBeenCalledTimes(1)
  })
})

describe('HoustonClient resize on the WS wire (item 10b)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends exactly one session_resize when the ack matches on the first try', async () => {
    const { client, ws } = await connectFakeClient()

    const resizeSends = (): unknown[] =>
      ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_resize')

    client.resizeSession(1, 80, 24)
    expect(resizeSends()).toHaveLength(1)

    ws.onmessage?.({
      data: JSON.stringify({ type: 'session_resized', session: 1, cols: 80, rows: 24 })
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(resizeSends()).toHaveLength(1)
  })
})

describe('WsTerminalTransport attach dedup + settling (item 11, r4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const attachSends = (ws: MockWebSocket): unknown[] =>
    ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_attach')

  it('concurrent attachSession() calls for the same session share one session_attach on the wire', async () => {
    const { client, ws } = await connectFakeClient()

    client.attachSession(5)
    client.attachSession(5)
    client.attachSession(5)

    expect(attachSends(ws)).toHaveLength(1)
  })

  it('a second attach() while the first is still pending shares the SAME promise, and onReplay still fires exactly once when it settles', async () => {
    const { client, ws } = await connectFakeClient()
    const transport = getTransport(client)

    const first = transport.attach(5)
    expect(attachSends(ws)).toHaveLength(1)

    const second = transport.attach(5)
    expect(attachSends(ws)).toHaveLength(1)

    let replayCount = 0
    client.onReplay = () => {
      replayCount++
    }
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'scrollback',
        session: 5,
        data: '',
        generation: 1,
        attempt: 1,
        replayed_bytes: 0,
        bytes_seen: 42
      })
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(secondResult)
    expect(replayCount).toBe(1)
  })

  it('a timed-out attach clears the in-flight entry so a later attach for the same session issues a fresh invoke and can succeed', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()
    const transport = getTransport(client)

    const firstAttach = transport.attach(5)
    const firstAttachError = firstAttach.catch((e: unknown) => e)
    expect(attachSends(ws)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1500)
    const err = await firstAttachError
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(
      /session_attach reply for session 5 .* timed out after 1500ms/
    )

    const secondAttach = transport.attach(5)
    expect(attachSends(ws)).toHaveLength(2)

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'scrollback',
        session: 5,
        data: '',
        generation: 2,
        attempt: 2,
        replayed_bytes: 0,
        bytes_seen: 7
      })
    })
    await expect(secondAttach).resolves.toEqual({
      generation: 2,
      replayedBytes: 0,
      bytesSeen: 7,
      lastDataAtMs: expect.any(Number),
      snapshot: false
    })

    vi.useRealTimers()
  })

  it('a waiter still pending when the transport is disposed rejects instead of hanging forever', async () => {
    const { client } = await connectFakeClient()
    const transport = getTransport(client)

    const pending = transport.attach(5)
    client.close()

    await expect(pending).rejects.toThrow(/session_attach reply for session 5 .* abandoned/)
  })
})

describe('HoustonClient waitForReady (item 12, r10)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves true on the first non-empty data frame for that session, and does not resolve on an empty one', async () => {
    const { client, ws } = await connectFakeClient()
    let settled: boolean | null = null
    void client.waitForReady(3).then((r) => {
      settled = r
    })

    ws.onmessage?.({ data: encodeOutputFrame(3, 0, new Uint8Array()) })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBeNull()

    ws.onmessage?.({ data: encodeOutputFrame(3, 0, new Uint8Array([9, 9])) })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('a resize ack alone -- even one that matches the request exactly, as Houston\'s own dead-map guard for a restored husk returns the requested dims verbatim -- does NOT mark the session ready; only a first non-empty data frame does', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()
    const resizeMock = vi.fn().mockResolvedValue({ cols: 80, rows: 24 })
    getTransport(client).resize = resizeMock

    let settled: boolean | null = null
    void client.waitForReady(1).then((r) => {
      settled = r
    })
    client.resizeSession(1, 80, 24)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBeNull()

    await vi.advanceTimersByTimeAsync(2500)
    expect(settled).toBe(false)

    vi.useRealTimers()
  })

  it('a late data frame arriving after the session\'s exit was observed does not resurrect readiness', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    ws.onmessage?.({ data: encodeOutputFrame(8, 0, new Uint8Array([1])) })
    await vi.advanceTimersByTimeAsync(0)
    await expect(client.waitForReady(8)).resolves.toBe(true)

    getTransport(client).onExit(8, 0)

    ws.onmessage?.({ data: encodeOutputFrame(8, 10, new Uint8Array([2])) })
    await vi.advanceTimersByTimeAsync(0)

    let settled: boolean | null = null
    void client.waitForReady(8, 100).then((r) => {
      settled = r
    })
    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)

    vi.useRealTimers()
  })

  it('resolves false after exactly 2500ms with neither a data frame nor a resize ack -- a timeout is a signal, not a rejection', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()

    let settled: boolean | null = null
    void client.waitForReady(9).then((r) => {
      settled = r
    })

    await vi.advanceTimersByTimeAsync(2499)
    expect(settled).toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)

    vi.useRealTimers()
  })

  it('a session already marked ready resolves waitForReady immediately, without waiting for a fresh frame', async () => {
    const { client, ws } = await connectFakeClient()
    ws.onmessage?.({ data: encodeOutputFrame(4, 0, new Uint8Array([1])) })
    await Promise.resolve()

    await expect(client.waitForReady(4)).resolves.toBe(true)
  })

  it('close() settles every pending waitForReady() caller with false immediately, instead of leaving it to time out', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()

    let settled: boolean | null = null
    void client.waitForReady(2).then((r) => {
      settled = r
    })
    expect(settled).toBeNull()

    client.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(2500)
    expect(settled).toBe(false)

    vi.useRealTimers()
  })
})

describe('HoustonClient dead-session suppression set (item 14, r11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const cwdSends = (ws: MockWebSocket): unknown[] =>
    ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_cwd')

  const sessionRemoved = (ws: MockWebSocket, session: number): void => {
    ws.onmessage?.({ data: JSON.stringify({ type: 'session_removed', session }) })
  }

  it('onExit (a PTY exit, not destruction) does not populate the dead-set -- an exited-but-still-visible pane\'s cwd query still reaches the wire', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    getTransport(client).onExit(5, 0)
    await vi.advanceTimersByTimeAsync(10_000)

    client.sessionCwd(5).catch(() => {})
    expect(cwdSends(ws)).toHaveLength(1)

    vi.useRealTimers()
  })

  it('session_removed (destruction) suppresses immediately, with no grace delay', async () => {
    const { client, ws } = await connectFakeClient()

    sessionRemoved(ws, 6)

    await expect(client.sessionCwd(6)).rejects.toThrow(/suppressed for session 6/)
  })

  it('sessionCwds and sessionRunningProcs filter dead ids out of the batch, and send nothing when the whole batch is dead', async () => {
    const { client, ws } = await connectFakeClient()

    sessionRemoved(ws, 5)

    const cwdsSends = (): unknown[] =>
      ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_cwds')
    const procsSends = (): unknown[] =>
      ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_running_procs')

    client.sessionCwds([5])
    expect(cwdsSends()).toHaveLength(0)
    client.sessionCwds([5, 6])
    expect(cwdsSends()).toHaveLength(1)
    expect(JSON.parse(cwdsSends()[0] as string).sessions).toEqual([6])

    client.sessionRunningProcs([5])
    expect(procsSends()).toHaveLength(0)
    client.sessionRunningProcs([5, 7])
    expect(procsSends()).toHaveLength(1)
    expect(JSON.parse(procsSends()[0] as string).sessions).toEqual([7])
  })

  it('respawnSession does NOT un-suppress the old (destroyed) id -- it stays suppressed permanently, since ids are never reused', async () => {
    const { client, ws } = await connectFakeClient()

    sessionRemoved(ws, 9)
    await expect(client.sessionCwd(9)).rejects.toThrow(/suppressed for session 9/)

    client.respawnSession(9)
    await expect(client.sessionCwd(9)).rejects.toThrow(/suppressed for session 9/)
    expect(cwdSends(ws)).toHaveLength(0)
  })

  it('caps the dead-set at 512 and evicts the oldest 128 on the 513th insert', async () => {
    const { client, ws } = await connectFakeClient()

    for (let id = 1; id <= 513; id++) sessionRemoved(ws, id)

    ws.sent.length = 0
    client.sessionCwds(Array.from({ length: 513 }, (_, i) => i + 1))

    const sent = ws.sent
      .filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_cwds')
      .map((m) => JSON.parse(m as string).sessions as number[])
    expect(sent).toHaveLength(1)
    const live = new Set(sent[0])

    for (let id = 1; id <= 128; id++) expect(live.has(id)).toBe(true)
    for (let id = 129; id <= 513; id++) expect(live.has(id)).toBe(false)
    expect(live.size).toBe(128)
  })

  it('is not load-bearing for pane presence -- session_removed and session_state still reach the dispatch seam unchanged', async () => {
    const { client, ws } = await connectFakeClient()
    const received: unknown[] = []
    client.subscribeAll((msg) => received.push(msg))

    ws.onmessage?.({ data: JSON.stringify({ type: 'session_removed', session: 5 }) })
    ws.onmessage?.({ data: JSON.stringify({ type: 'session_state', sessions: [] }) })

    expect(received).toEqual([
      { type: 'session_removed', session: 5 },
      { type: 'session_state', sessions: [] }
    ])
  })
})

describe('HoustonClient cwd cache (item 15, r12)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const cwdSends = (ws: MockWebSocket): unknown[] =>
    ws.sent.filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_cwd')

  const resolveCwd = (ws: MockWebSocket, session: number, cwd: string): void => {
    ws.onmessage?.({ data: JSON.stringify({ type: 'session_cwd', session, cwd }) })
  }

  it('the cwd cache TTL constant is exactly 5000ms', () => {
    expect(CWD_CACHE_TTL_MS).toBe(5000)
  })

  it('serves a cache hit within the 5s TTL without re-querying the wire', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(1)
    resolveCwd(ws, 1, '/home/x')
    await expect(p1).resolves.toBe('/home/x')
    expect(cwdSends(ws)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(4999)
    await expect(client.sessionCwd(1)).resolves.toBe('/home/x')
    expect(cwdSends(ws)).toHaveLength(1)

    vi.useRealTimers()
  })

  it('re-queries the wire once the 5s TTL has elapsed', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(2)
    resolveCwd(ws, 2, '/home/y')
    await expect(p1).resolves.toBe('/home/y')
    expect(cwdSends(ws)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5000)
    const p2 = client.sessionCwd(2)
    expect(cwdSends(ws)).toHaveLength(2)
    resolveCwd(ws, 2, '/home/y2')
    await expect(p2).resolves.toBe('/home/y2')

    vi.useRealTimers()
  })

  it('a write containing \\n invalidates the cache', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(3)
    resolveCwd(ws, 3, '/repo')
    await expect(p1).resolves.toBe('/repo')

    client.sendStdin(3, 'cd sub\n')

    const p2 = client.sessionCwd(3)
    expect(cwdSends(ws)).toHaveLength(2)
    resolveCwd(ws, 3, '/repo/sub')
    await expect(p2).resolves.toBe('/repo/sub')
  })

  it('a write containing \\r invalidates the cache', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(4)
    resolveCwd(ws, 4, '/repo')
    await expect(p1).resolves.toBe('/repo')

    client.sendStdin(4, 'cd sub\r')

    const p2 = client.sessionCwd(4)
    expect(cwdSends(ws)).toHaveLength(2)
    resolveCwd(ws, 4, '/repo/sub')
    await expect(p2).resolves.toBe('/repo/sub')
  })

  it('a write containing neither \\n nor \\r does not invalidate the cache', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(6)
    resolveCwd(ws, 6, '/repo')
    await expect(p1).resolves.toBe('/repo')

    client.sendStdin(6, 'cd sub')

    await expect(client.sessionCwd(6)).resolves.toBe('/repo')
    expect(cwdSends(ws)).toHaveLength(1)
  })

  it('a stale in-flight answer does not repopulate the cache after a mid-flight invalidation (the race the generation counter exists for)', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(7)
    expect(cwdSends(ws)).toHaveLength(1)

    client.sendStdin(7, '\n')

    resolveCwd(ws, 7, '/stale')
    await expect(p1).resolves.toBe('/stale')

    const p2 = client.sessionCwd(7)
    expect(cwdSends(ws)).toHaveLength(2)
    resolveCwd(ws, 7, '/fresh')
    await expect(p2).resolves.toBe('/fresh')
  })

  it('a dead-set session is not served from a cache entry populated before it died', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(8)
    resolveCwd(ws, 8, '/repo')
    await expect(p1).resolves.toBe('/repo')

    ws.onmessage?.({ data: JSON.stringify({ type: 'session_removed', session: 8 }) })

    await expect(client.sessionCwd(8)).rejects.toThrow(/suppressed for session 8/)
    expect(cwdSends(ws)).toHaveLength(1)
  })

  it('settles (rejects) on a wire timeout, same as before this item', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()

    const p = client.sessionCwd(9)
    const err = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1500)
    const settled = await err
    expect(settled).toBeInstanceOf(Error)
    expect((settled as Error).message).toMatch(/session_cwd timed out for session 9/)

    vi.useRealTimers()
  })

  it('a second concurrent sessionCwd() call for the same session shares the SAME promise and issues only ONE session_cwd', async () => {
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(10)
    const p2 = client.sessionCwd(10)
    expect(cwdSends(ws)).toHaveLength(1)

    resolveCwd(ws, 10, '/shared')
    await expect(p1).resolves.toBe('/shared')
    await expect(p2).resolves.toBe('/shared')
  })

  it('a rejected (timed-out) shared sessionCwd() query clears the in-flight entry so a later call issues a fresh query and can succeed', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    const p1 = client.sessionCwd(11)
    const p2 = client.sessionCwd(11)
    expect(cwdSends(ws)).toHaveLength(1)

    const err1 = p1.catch((e: unknown) => e)
    const err2 = p2.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await err1).toBeInstanceOf(Error)
    expect(await err2).toBeInstanceOf(Error)

    const p3 = client.sessionCwd(11)
    expect(cwdSends(ws)).toHaveLength(2)
    resolveCwd(ws, 11, '/after-timeout')
    await expect(p3).resolves.toBe('/after-timeout')

    vi.useRealTimers()
  })
})

describe('HoustonClient.confirmReparentSession (Phase 6 item 2 fix round, F1)', () => {
  const reparentSends = (
    ws: MockWebSocket
  ): Array<{ type: string; session: number; project_dir: string }> =>
    ws.sent
      .filter((m) => typeof m === 'string' && JSON.parse(m).type === 'session_reparent')
      .map((m) => JSON.parse(m as string))

  const sessionReparented = (ws: MockWebSocket, session: number, projectDir: string): void => {
    ws.onmessage?.({
      data: JSON.stringify({ type: 'session_reparented', session, project_dir: projectDir })
    })
  }

  it('sends session_reparent and resolves on the matching session_reparented broadcast', async () => {
    const { client, ws } = await connectFakeClient()

    const p = client.confirmReparentSession(1, '/tmp/target')
    expect(reparentSends(ws)).toEqual([
      { type: 'session_reparent', session: 1, project_dir: '/tmp/target' }
    ])

    sessionReparented(ws, 1, '/tmp/target')
    await expect(p).resolves.toBeUndefined()
  })

  it('ignores a session_reparented broadcast for a DIFFERENT session and keeps waiting', async () => {
    const { client, ws } = await connectFakeClient()

    let settled = false
    const p = client.confirmReparentSession(2, '/tmp/target').then(() => {
      settled = true
    })

    sessionReparented(ws, 99, '/tmp/other')
    await Promise.resolve()
    expect(settled).toBe(false)

    sessionReparented(ws, 2, '/tmp/target')
    await p
    expect(settled).toBe(true)
  })

  it('ignores a session_reparented broadcast for the SAME session but a DIFFERENT project_dir (a stale/unrelated move) and keeps waiting', async () => {
    const { client, ws } = await connectFakeClient()

    let settled = false
    const p = client.confirmReparentSession(3, '/tmp/target').then(() => {
      settled = true
    })

    sessionReparented(ws, 3, '/tmp/somewhere-else')
    await Promise.resolve()
    expect(settled).toBe(false)

    sessionReparented(ws, 3, '/tmp/target')
    await p
    expect(settled).toBe(true)
  })

  it('rejects, naming the session and the target root, once the confirmation times out (the refusal path)', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()

    const p = client.confirmReparentSession(5, '/tmp/refused')
    const caught = p.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(1999)
    let settled = false
    void p.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('session 5')
    expect((err as Error).message).toContain('/tmp/refused')

    vi.useRealTimers()
  })

  it('a broadcast that arrives AFTER the timeout has already rejected does not throw or double-settle', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connectFakeClient()

    const p = client.confirmReparentSession(6, '/tmp/late')
    const caught = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await caught).toBeInstanceOf(Error)

    expect(() => sessionReparented(ws, 6, '/tmp/late')).not.toThrow()

    vi.useRealTimers()
  })

  it('respects a custom timeoutMs override', async () => {
    vi.useFakeTimers()
    const { client } = await connectFakeClient()

    const p = client.confirmReparentSession(7, '/tmp/fast', 100)
    const caught = p.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(99)
    let settled = false
    void p.then(
      () => (settled = true),
      () => (settled = true)
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(await caught).toBeInstanceOf(Error)

    vi.useRealTimers()
  })
})

describe('HoustonClient destroy intents + confirmed re-sends (v62 D3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('records kill/close intents at the dispatch sites and takes them back once', async () => {
    const { client } = await connectFakeClient()

    client.killSession(1)
    client.closeSession(2)

    expect(client.takeRecentDestroyIntent()).toEqual({ session: 2, kind: 'close' })
    expect(client.takeRecentDestroyIntent()).toEqual({ session: 1, kind: 'kill' })
    expect(client.takeRecentDestroyIntent()).toBeNull()
  })

  it('the freshest intent wins when several are pending', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      const { client } = await connectFakeClient()

      nowSpy.mockReturnValue(1000)
      client.killSession(3)
      nowSpy.mockReturnValue(1010)
      client.closeSession(4)

      expect(client.takeRecentDestroyIntent()).toEqual({ session: 4, kind: 'close' })
      expect(client.takeRecentDestroyIntent()).toEqual({ session: 3, kind: 'kill' })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('a stale intent is not claimable and gets pruned', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      const { client } = await connectFakeClient()

      nowSpy.mockReturnValue(1000)
      client.closeSession(9)
      nowSpy.mockReturnValue(1000 + 10_000 + 1)
      expect(client.takeRecentDestroyIntent()).toBeNull()
      nowSpy.mockReturnValue(1000 + 10_000 + 2)
      expect((client as unknown as { destroyIntents: Map<number, unknown> }).destroyIntents.size).toBe(0)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('confirmed re-sends carry confirm_children on the SAME message type', async () => {
    const { client, ws } = await connectFakeClient()

    client.confirmCloseSession(5)
    client.confirmKillSession(6)

    const sent = ws.sent.map((raw) => JSON.parse(raw as string))
    expect(sent).toContainEqual({ type: 'session_close', session: 5, confirm_children: true })
    expect(sent).toContainEqual({ type: 'session_kill', session: 6, confirm_children: true })
  })

  it('orchestration settings get/set go out on the control link', async () => {
    const { client, ws } = await connectFakeClient()

    client.orchestrationSettingsGet()
    client.orchestrationSet(true)

    const sent = ws.sent.map((raw) => JSON.parse(raw as string))
    expect(sent).toContainEqual({ type: 'orchestration_settings_get' })
    expect(sent).toContainEqual({ type: 'orchestration_set', enabled: true })
  })
})
