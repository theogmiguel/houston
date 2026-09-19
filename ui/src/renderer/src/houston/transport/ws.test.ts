// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WsTerminalTransport } from './ws'
import type { ClientMsg } from '../generated/ClientMsg'

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

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = MockWebSocket.OPEN
  sent: ClientMsg[] = []
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMsg)
  }
}

function makeTransport(): WsTerminalTransport {
  return new WsTerminalTransport(new MockWebSocket() as unknown as WebSocket)
}

function makeTransportWithSocket(): { transport: WsTerminalTransport; ws: MockWebSocket } {
  const ws = new MockWebSocket()
  return { transport: new WsTerminalTransport(ws as unknown as WebSocket), ws }
}

describe('WsTerminalTransport onExit', () => {
  it('fires onExit with the exit code when the daemon broadcasts session_state: exited', () => {
    const transport = makeTransport()
    let received: [number, number | null] | null = null
    transport.onExit = (session, exitCode) => {
      received = [session, exitCode]
    }

    transport.handleControlMessage({
      type: 'session_state',
      session: 7,
      state: 'exited',
      exit_code: 3
    })

    expect(received).toEqual([7, 3])
  })

  it('fires onExit for a killed session too', () => {
    const transport = makeTransport()
    let received: [number, number | null] | null = null
    transport.onExit = (session, exitCode) => {
      received = [session, exitCode]
    }

    transport.handleControlMessage({
      type: 'session_state',
      session: 9,
      state: 'killed',
      exit_code: null
    })

    expect(received).toEqual([9, null])
  })

  it('does not fire onExit for a running session, or an interrupted one (a boot restoring a husk)', () => {
    const transport = makeTransport()
    let calls = 0
    transport.onExit = () => {
      calls++
    }

    transport.handleControlMessage({
      type: 'session_state',
      session: 1,
      state: 'running',
      exit_code: null
    })
    transport.handleControlMessage({
      type: 'session_state',
      session: 2,
      state: 'interrupted',
      exit_code: null
    })

    expect(calls).toBe(0)
  })
})

describe('WsTerminalTransport frame dispatch', () => {
  it('delivers an output frame to onFrame with (session, offset, payload), driven through the real handleBinaryMessage decoder', () => {
    const transport = makeTransport()
    let received: [number, number, Uint8Array] | null = null
    transport.onFrame = (session, offset, payload) => {
      received = [session, offset, payload]
    }

    const payload = new Uint8Array([1, 2, 3])
    transport.handleBinaryMessage(encodeOutputFrame(7, 42, payload))

    expect(received).toEqual([7, 42, payload])
  })

  it('delivers an output frame via onFrame even with no attach ever requested for that session -- ws.ts does not gate frames on attach state', () => {
    const transport = makeTransport()
    let received: [number, number, Uint8Array] | null = null
    transport.onFrame = (session, offset, payload) => {
      received = [session, offset, payload]
    }

    const payload = new Uint8Array([9])
    transport.handleBinaryMessage(encodeOutputFrame(3, 0, payload))

    expect(received).toEqual([3, 0, payload])
  })

  it('delivers a gap (kind-3) frame to onGap with argument order (session, bytesSeen, droppedBytes), driven through the real handleBinaryMessage decoder', () => {
    const transport = makeTransport()
    let received: [number, number, number] | null = null
    transport.onGap = (session, bytesSeen, droppedBytes) => {
      received = [session, bytesSeen, droppedBytes]
    }

    transport.handleBinaryMessage(encodeGapFrame(7, 500, 128))

    expect(received).toEqual([7, 500, 128])
  })
})

describe('WsTerminalTransport attach dedup (item 11, r4 -- WS side)', () => {
  it('concurrent attach() calls for the same session share one session_attach send', () => {
    const { transport, ws } = makeTransportWithSocket()

    void transport.attach(7)
    void transport.attach(7)
    void transport.attach(7)

    const attachSends = ws.sent.filter((m) => m.type === 'session_attach')
    expect(attachSends).toHaveLength(1)
  })

  it('attachSession sends session_attach with the given replay_bytes', () => {
    const { transport, ws } = makeTransportWithSocket()

    void transport.attach(7, 500)

    expect(ws.sent).toEqual([{ type: 'session_attach', session: 7, replay_bytes: 500 }])
  })

  it('a second attach() while the first is pending resolves together once the scrollback reply arrives', async () => {
    const { transport, ws } = makeTransportWithSocket()

    const first = transport.attach(7)
    const second = transport.attach(7)
    expect(ws.sent.filter((m) => m.type === 'session_attach')).toHaveLength(1)

    transport.handleControlMessage({
      type: 'scrollback',
      session: 7,
      data: '',
      generation: 1,
      replayed_bytes: 0,
      bytes_seen: 0,
      attempt: 1
    })

    await expect(first).resolves.toEqual(await second)
  })
})

describe('WsTerminalTransport attachment generation (scrollback.attempt)', () => {
  function reply(session: number, attempt: number, bytesSeen: number) {
    return {
      type: 'scrollback',
      session,
      data: '',
      generation: 1,
      replayed_bytes: 0,
      bytes_seen: bytesSeen,
      attempt
    }
  }

  it('counts attaches per session: the daemon numbers replies the same way', async () => {
    const { transport } = makeTransportWithSocket()
    const replays: number[] = []
    transport.onReplay = (_session, _data, bytesSeen) => replays.push(bytesSeen)

    const first = transport.attach(7)
    transport.handleControlMessage(reply(7, 1, 10))
    await expect(first).resolves.toMatchObject({ bytesSeen: 10 })

    const second = transport.attach(7)
    transport.handleControlMessage(reply(7, 2, 20))
    await expect(second).resolves.toMatchObject({ bytesSeen: 20 })

    expect(replays).toEqual([10, 20])
  })

  it('ignores a reply to an attach it already gave up on, and still honours the newest one', async () => {
    const { transport } = makeTransportWithSocket()
    const replays: number[] = []
    transport.onReplay = (_session, _data, bytesSeen) => replays.push(bytesSeen)

    void transport.attach(7).catch(() => {})
    transport.dispose()
    const { transport: fresh } = makeTransportWithSocket()
    fresh.onReplay = (_session, _data, bytesSeen) => replays.push(bytesSeen)
    void fresh.attach(7).catch(() => {})
    const newest = fresh.attach(7)
    fresh.handleControlMessage(reply(7, 0, 5))
    expect(replays).toEqual([])

    fresh.handleControlMessage(reply(7, 1, 42))
    await expect(newest).resolves.toMatchObject({ bytesSeen: 42 })
    expect(replays).toEqual([42])
  })

  it('a stale reply arriving after a newer attach was sent neither resolves the newer waiter nor replays', async () => {
    const { transport } = makeTransportWithSocket()
    const replays: number[] = []
    transport.onReplay = (_session, _data, bytesSeen) => replays.push(bytesSeen)

    const first = transport.attach(7)
    transport.handleControlMessage(reply(7, 1, 10))
    await first
    const second = transport.attach(7)
    transport.handleControlMessage(reply(7, 1, 10))
    expect(replays).toEqual([10])
    let settled = false
    void second.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    transport.handleControlMessage(reply(7, 2, 30))
    await expect(second).resolves.toMatchObject({ bytesSeen: 30 })
    expect(replays).toEqual([10, 30])
  })

  it('ignores a scrollback for a session this transport never attached', () => {
    const { transport } = makeTransportWithSocket()
    const replays: number[] = []
    transport.onReplay = (_session, _data, bytesSeen) => replays.push(bytesSeen)
    transport.handleControlMessage(reply(9, 1, 10))
    expect(replays).toEqual([])
  })
})

describe('WsTerminalTransport control ops (setVisible/destroy)', () => {
  it('setVisible sends session_visibility with the given session and visibility', () => {
    const { transport, ws } = makeTransportWithSocket()

    transport.setVisible(9, true)

    expect(ws.sent).toEqual([{ type: 'session_visibility', session: 9, visible: true }])
  })

  it('destroy sends session_close for the given session', () => {
    const { transport, ws } = makeTransportWithSocket()

    transport.destroy(7)

    expect(ws.sent).toEqual([{ type: 'session_close', session: 7 }])
  })
})

describe('WsTerminalTransport create forwards acp and profile (v62 #11 / v67 -- WS side)', () => {
  it('passes acp straight through to session_create, and omits the key entirely when the pane is an ordinary one', () => {
    const { transport, ws } = makeTransportWithSocket()

    void transport.create({
      agent: 'grok',
      project_dir: '/tmp/project',
      acp: 'acp-grok',
      shell_integration: false
    })
    void transport.create({ agent: 'shell', project_dir: '/tmp/project' })

    const creates = ws.sent.filter((m) => m.type === 'session_create')
    expect(creates).toHaveLength(2)
    expect((creates[0] as { acp?: string | null }).acp).toBe('acp-grok')
    expect(creates[1]).not.toHaveProperty('acp')
  })

  it('passes profile straight through to session_create, and omits the key entirely when none was chosen', () => {
    const { transport, ws } = makeTransportWithSocket()

    void transport.create({
      agent: 'claude',
      project_dir: '/tmp/project',
      profile: { kind: 'profile', id: 3 }
    })
    void transport.create({ agent: 'claude', project_dir: '/tmp/project' })

    const creates = ws.sent.filter((m) => m.type === 'session_create')
    expect(creates).toHaveLength(2)
    expect((creates[0] as { profile?: unknown }).profile).toEqual({ kind: 'profile', id: 3 })
    expect(creates[1]).not.toHaveProperty('profile')
  })
})

describe('WsTerminalTransport snapshot attach (v94)', () => {
  function snapshotReply(session: number, attempt: number, outputOffset: number, state: string) {
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

  it('sends snapshot: true only when asked, so a v93 attach is byte-for-byte what it was', () => {
    const { transport, ws } = makeTransportWithSocket()
    void transport.attach(3, 1024)
    void transport.attach(4, 1024, true)
    expect(ws.sent[0]).toEqual({
      type: 'session_attach',
      session: 3,
      replay_bytes: 1024,
      snapshot: undefined
    })
    expect(ws.sent[1]).toEqual({
      type: 'session_attach',
      session: 4,
      replay_bytes: 1024,
      snapshot: true
    })
  })

  it('resolves the attach with snapshot: true and hands the state to onSnapshot', async () => {
    const transport = makeTransport()
    const seen: [number, number, number][] = []
    transport.onSnapshot = (session, state, outputOffset) =>
      seen.push([session, state.length, outputOffset])

    const attach = transport.attach(5, undefined, true)
    transport.handleControlMessage(snapshotReply(5, 1, 4096, 'SFZUUw=='))

    await expect(attach).resolves.toEqual({
      generation: 1,
      replayedBytes: 0,
      bytesSeen: 4096,
      lastDataAtMs: expect.any(Number),
      snapshot: true
    })
    expect(seen).toEqual([[5, 4, 4096]])
  })

  it('ignores a snapshot answering an attach it already gave up on', () => {
    const transport = makeTransport()
    let calls = 0
    transport.onSnapshot = () => {
      calls++
    }

    const first = transport.attach(5, undefined, true)
    transport.handleControlMessage(snapshotReply(5, 1, 10, 'SFZUUw=='))
    void first
    void transport.attach(5, undefined, true)

    transport.handleControlMessage(snapshotReply(5, 1, 10, 'SFZUUw=='))
    expect(calls).toBe(1)

    transport.handleControlMessage(snapshotReply(5, 2, 20, 'SFZUUw=='))
    expect(calls).toBe(2)
  })
})
