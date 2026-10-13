import type { ClientMsg } from '../generated/ClientMsg'
import type { AttachResult, ResizeResult, TerminalTransport } from './types'
import { decodeGapFrame } from './types'
import { inputSocketForSession } from './inputSocket'
import {
  type CreateSessionParams,
  decodeBase64,
  decodeOutputFrame,
  encodeStdinFrame
} from '../client'
import type { SessionInfo } from '../generated/SessionInfo'

// At least four maximum paste transactions fit before admission stops. Replies have a
// separate 64 KiB reserve so a saturated operator backlog does not lose queries.
export const MAX_SOCKET_INPUT_BYTES = 1024 * 1024
export const REPLY_RESERVE_BYTES = 64 * 1024
const MAX_INPUT_FRAME_BYTES = 256 * 1024

const RESIZE_ACK_TIMEOUT_MS = 1500

const ATTACH_REPLY_TIMEOUT_MS = 1500

const CREATE_REPLY_TIMEOUT_MS = 3000

export interface WsGapStats {
  gaps: number
  reattaches: number
}

const wsGapStats: WsGapStats = { gaps: 0, reattaches: 0 }
;(globalThis as unknown as { __trWsGapStats__: WsGapStats }).__trWsGapStats__ = wsGapStats

type FrameTap = (session: number, payload: Uint8Array) => void

/** Set only by the bench harness, to time when output reaches the renderer. */
function benchFrameTap(): FrameTap | undefined {
  return (globalThis as { __trBenchFrameTap__?: FrameTap }).__trBenchFrameTap__
}

export class WsTerminalTransport implements TerminalTransport {
  private encoder = new TextEncoder()

  private attachWaiters = new Map<
    number,
    {
      resolve: (r: AttachResult) => void
      reject: (err: Error) => void
      promise: Promise<AttachResult>
      replayBytes: number | undefined
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private resizeWaiters = new Map<
    number,
    {
      resolve: (r: ResizeResult) => void
      reject: (err: Error) => void
      cols: number
      rows: number
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private nextCreateRequest = 0
  private createWaiters = new Map<number, {
    resolve: (info: SessionInfo) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private attachesSent = new Map<number, number>()
  // The run each session's last replay or snapshot described; an offset attach names it
  // so the daemon can refuse an offset from an earlier run.
  private generations = new Map<number, number>()

  onFrame: TerminalTransport['onFrame'] = () => {}
  onReplay: TerminalTransport['onReplay'] = () => {}
  onSnapshot: TerminalTransport['onSnapshot'] = () => {}
  onGap: TerminalTransport['onGap'] = () => {}
  onExit: TerminalTransport['onExit'] = () => {}

  constructor(private ws: WebSocket) {}

  private send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return
    }
    console.warn(
      `houston: dropped ${msg.type} — socket is ${['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][this.ws.readyState] ?? this.ws.readyState}`
    )
  }

  create(params: CreateSessionParams): Promise<SessionInfo> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('session_create refused — socket is not open'))
    }
    const request = ++this.nextCreateRequest
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.createWaiters.delete(request)
        reject(new Error(`session_create request ${request} timed out after ${CREATE_REPLY_TIMEOUT_MS}ms`))
      }, CREATE_REPLY_TIMEOUT_MS)
      this.createWaiters.set(request, { resolve, reject, timer })
      try {
        this.send({ type: 'session_create', ...params, request })
      } catch (error) {
        clearTimeout(timer)
        this.createWaiters.delete(request)
        reject(error)
      }
    })
  }

  attach(session: number, replayBytes?: number, snapshot?: boolean, fromOffset?: number): Promise<AttachResult> {
    const existing = this.attachWaiters.get(session)
    if (existing) return existing.promise
    let resolve!: (r: AttachResult) => void
    let reject!: (err: Error) => void
    const promise = new Promise<AttachResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(() => {
      this.attachWaiters.delete(session)
      reject(
        new Error(
          `session_attach reply for session ${session} (replay_bytes=${replayBytes ?? 'default'}) timed out after ${ATTACH_REPLY_TIMEOUT_MS}ms`
        )
      )
    }, ATTACH_REPLY_TIMEOUT_MS)
    this.attachWaiters.set(session, { resolve, reject, promise, replayBytes, timer })
    if ((this.attachesSent.get(session) ?? 0) > 0) wsGapStats.reattaches++
    this.attachesSent.set(session, (this.attachesSent.get(session) ?? 0) + 1)
    const generation = this.generations.get(session)
    const offset = fromOffset !== undefined && generation !== undefined ? { from_offset: fromOffset, generation } : {}
    this.send({ type: 'session_attach', session, replay_bytes: replayBytes, snapshot, ...offset })
    return promise
  }

  write(session: number, data: string, reply = false): boolean {
    const socket = inputSocketForSession(this.ws, session)
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Input refused for session ${session}: socket state ${socket.readyState}; expected OPEN (${WebSocket.OPEN})`)
    }
    const actual = socket.bufferedAmount ?? 0
    const limit = MAX_SOCKET_INPUT_BYTES + (reply ? REPLY_RESERVE_BYTES : 0)
    // Refuse before encoding or frame allocation when even the minimum cannot fit.
    if (data.length > MAX_INPUT_FRAME_BYTES || actual + data.length + 5 > limit) {
      throw new Error(`Input refused for session ${session}: current socket backlog ${actual} bytes; requested ${data.length} code units plus 5 framing bytes; limit ${limit} bytes (frame limit ${MAX_INPUT_FRAME_BYTES} code units)`)
    }
    const bytes = this.encoder.encode(data)
    if (bytes.length + 5 > MAX_INPUT_FRAME_BYTES || actual + bytes.length + 5 > limit) {
      throw new Error(`Input refused for session ${session}: current socket backlog ${actual} bytes; requested ${bytes.length + 5} bytes; limit ${limit} bytes (frame limit ${MAX_INPUT_FRAME_BYTES} bytes)`)
    }
    this.ws.send(encodeStdinFrame(session, bytes))
    return true
  }

  resize(session: number, cols: number, rows: number): Promise<ResizeResult> {
    return new Promise((resolve, reject) => {
      const existing = this.resizeWaiters.get(session)
      if (existing) {
        clearTimeout(existing.timer)
        existing.reject(
          new Error(
            `session_resize ack for session ${session} (${existing.cols}x${existing.rows}) superseded by a new resize (${cols}x${rows}) before it arrived`
          )
        )
      }
      const timer = setTimeout(() => {
        this.resizeWaiters.delete(session)
        reject(
          new Error(
            `session_resize ack for session ${session} (${cols}x${rows}) timed out after ${RESIZE_ACK_TIMEOUT_MS}ms`
          )
        )
      }, RESIZE_ACK_TIMEOUT_MS)
      this.resizeWaiters.set(session, { resolve, reject, cols, rows, timer })
      this.send({ type: 'session_resize', session, cols, rows })
    })
  }

  abandonAttach(session: number): void {
    const waiter = this.attachWaiters.get(session)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.attachWaiters.delete(session)
    waiter.reject(
      new Error(
        `session_attach reply for session ${session} abandoned — the pane reset and re-attached before it landed`
      )
    )
  }

  destroy(session: number): void {
    this.send({ type: 'session_close', session })
  }

  setVisible(session: number, visible: boolean): void {
    this.send({ type: 'session_visibility', session, visible })
  }

  handleControlMessage(msg: { type: string; [k: string]: unknown }): void {
    if (msg.type === 'session_removed') {
      const session = msg.session as number
      this.abandonAttach(session)
      const resize = this.resizeWaiters.get(session)
      if (resize) {
        clearTimeout(resize.timer)
        this.resizeWaiters.delete(session)
        resize.reject(new Error(`session_resize abandoned — session ${session} removed`))
      }
      this.attachesSent.delete(session)
      this.generations.delete(session)
      return
    }
    if (msg.type === 'scrollback') {
      const m = msg as unknown as {
        session: number
        data: string
        generation: number
        replayed_bytes: number
        bytes_seen: number
        attempt: number
      }
      const sent = this.attachesSent.get(m.session)
      if (sent === undefined || m.attempt !== sent) {
        console.warn(
          `houston: ignored scrollback for session ${m.session} — it answers attach #${m.attempt}, the newest sent is #${sent}`
        )
        return
      }
      this.generations.set(m.session, m.generation)
      const data = decodeBase64(m.data)
      this.onReplay(m.session, data, m.bytes_seen)
      const waiter = this.attachWaiters.get(m.session)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.attachWaiters.delete(m.session)
        waiter.resolve({
          generation: m.generation,
          replayedBytes: m.replayed_bytes,
          bytesSeen: m.bytes_seen,
          lastDataAtMs: Date.now(),
          snapshot: false
        })
      }
      return
    }
    if (msg.type === 'attach_snapshot') {
      const m = msg as unknown as {
        session: number
        generation: number
        attempt: number
        output_offset: number
        format_version: number
        state: string
      }
      const sent = this.attachesSent.get(m.session)
      if (sent === undefined || m.attempt !== sent) {
        console.warn(
          `houston: ignored attach_snapshot for session ${m.session} — it answers attach #${m.attempt}, the newest sent is #${sent}`
        )
        return
      }
      this.generations.set(m.session, m.generation)
      const waiter = this.attachWaiters.get(m.session)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.attachWaiters.delete(m.session)
        waiter.resolve({
          generation: m.generation,
          replayedBytes: 0,
          bytesSeen: m.output_offset,
          lastDataAtMs: Date.now(),
          snapshot: true
        })
      }
      this.onSnapshot(m.session, decodeBase64(m.state), m.output_offset)
      return
    }
    if (msg.type === 'session_resized') {
      const m = msg as unknown as { session: number; cols: number; rows: number }
      const waiter = this.resizeWaiters.get(m.session)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.resizeWaiters.delete(m.session)
        waiter.resolve({ cols: m.cols, rows: m.rows })
      }
      return
    }
    if (msg.type === 'session_create_result') {
      const m = msg as unknown as { request: number; info: SessionInfo | null; error: string | null }
      const entry = this.createWaiters.get(m.request)
      if (entry) {
        clearTimeout(entry.timer)
        this.createWaiters.delete(m.request)
        if (m.info && !m.error) entry.resolve(m.info)
        else entry.reject(new Error(m.error ?? `session_create request ${m.request} returned no session`))
      }
      return
    }
    if (msg.type === 'session_state') {
      const m = msg as unknown as { session: number; state: string; exit_code: number | null }
      if (m.state === 'exited' || m.state === 'killed') {
        this.onExit(m.session, m.exit_code)
      }
    }
  }

  handleBinaryMessage(buf: ArrayBuffer): void {
    if (buf.byteLength >= 1 && new Uint8Array(buf, 0, 1)[0] === 3) {
      const gap = decodeGapFrame(buf)
      if (gap) {
        wsGapStats.gaps++
        this.onGap(gap.session, gap.bytesSeen, gap.dropped)
      }
      return
    }
    const frame = decodeOutputFrame(buf)
    if (!frame) return
    benchFrameTap()?.(frame.session, frame.payload)
    this.onFrame(frame.session, frame.offset, frame.payload)
  }

  dispose(): void {
    for (const [session, w] of this.attachWaiters) {
      clearTimeout(w.timer)
      w.reject(
        new Error(
          `session_attach reply for session ${session} (replay_bytes=${w.replayBytes ?? 'default'}) abandoned — transport disposed`
        )
      )
    }
    this.attachWaiters.clear()
    for (const [session, w] of this.resizeWaiters) {
      clearTimeout(w.timer)
      w.reject(
        new Error(
          `session_resize ack for session ${session} (${w.cols}x${w.rows}) abandoned — transport disposed`
        )
      )
    }
    this.resizeWaiters.clear()
    for (const e of this.createWaiters.values()) {
      clearTimeout(e.timer)
      e.reject(new Error('session_create abandoned — transport disposed'))
    }
    this.createWaiters.clear()
    this.attachesSent.clear()
    this.generations.clear()
  }
}
