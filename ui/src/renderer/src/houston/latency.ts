import { isTauri } from './host'

export type WriteClass = 'enter' | 'backspace' | 'interactive' | 'control' | 'paste' | 'bulk'

export const BULK_THRESHOLD_CHARS = 4

const BRACKETED_PASTE_START = '\x1b[200~'

function isSingleControlByte(code: number): boolean {
  return code < 0x20 || code === 0x7f
}

export function classifyWrite(data: string): WriteClass {
  if (data === '\r' || data === '\n' || data === '\r\n') return 'enter'
  if (data === '\x7f' || data === '\b') return 'backspace'
  if (data.startsWith(BRACKETED_PASTE_START)) return 'paste'
  if (data.length >= 1 && (data.charCodeAt(0) === 0x1b || isSingleControlByte(data.charCodeAt(0)))) {
    return 'control'
  }
  if (data.length > BULK_THRESHOLD_CHARS) return 'bulk'
  return 'interactive'
}

export const ROUND_TRIP_THRESHOLD_MS = 250
export const WRITE_THRESHOLD_MS = 75
// One emission per 5 s per (session, message) pair — a write or resize storm
// would otherwise flood the log. Session ids are never reused, so `dropSession`
// must delete this map's keys or it grows for the app's whole life.
export const THROTTLE_WINDOW_MS = 5000

export const MAX_PENDING_MARKS_PER_SESSION = 8

export const STALE_MARK_MS = 5000

export interface LogPayload {
  source: string
  message: string
  payload: Record<string, unknown>
}

export function logTerminalTransport(entry: LogPayload): void {
  console.debug(`[${entry.source}] ${entry.message}`, entry.payload)
  if (!isTauri()) return
  void (async (): Promise<void> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('system_log_debug', {
        source: entry.source,
        message: entry.message,
        payload: entry.payload
      })
    } catch (err) {
      console.warn('logTerminalTransport: system_log_debug invoke failed', err)
    }
  })()
}

interface PendingMark {
  cls: WriteClass
  startedAtMs: number
}

export interface WriteLatencyTrackerOptions {
  now?: () => number
  sink?: (entry: LogPayload) => void
}

export class WriteLatencyTracker {
  private readonly now: () => number
  private readonly sink: (entry: LogPayload) => void
  private readonly pending = new Map<number, PendingMark[]>()
  private readonly lastEmittedMs = new Map<string, number>()
  private evictedByCap = 0

  constructor(options: WriteLatencyTrackerOptions = {}) {
    this.now = options.now ?? (() => performance.now())
    this.sink = options.sink ?? logTerminalTransport
  }

  recordWrite(session: number, data: string, writeDurationMs: number): void {
    const cls = classifyWrite(data)
    if (writeDurationMs > WRITE_THRESHOLD_MS) {
      this.emit(session, cls, 'slow write call', { writeDurationMs })
    }
    if (cls === 'bulk') return

    this.pruneStale(session)
    const queue = this.pending.get(session) ?? []
    if (queue.length >= MAX_PENDING_MARKS_PER_SESSION) {
      queue.shift()
      this.evictedByCap++
      this.emit(session, cls, 'round-trip mark dropped: pending queue exceeded its cap', {
        cap: MAX_PENDING_MARKS_PER_SESSION,
        totalDroppedByCap: this.evictedByCap
      })
    }
    queue.push({ cls, startedAtMs: this.now() })
    this.pending.set(session, queue)
  }

  closeOnFrame(session: number): void {
    const queue = this.pending.get(session)
    if (!queue || queue.length === 0) return
    const mark = queue.shift()!
    if (queue.length === 0) this.pending.delete(session)
    const roundTripMs = this.now() - mark.startedAtMs
    if (roundTripMs > ROUND_TRIP_THRESHOLD_MS) {
      this.emit(session, mark.cls, 'slow round trip', { roundTripMs })
    }
  }

  pendingMarkCount(session: number): number {
    return this.pending.get(session)?.length ?? 0
  }

  dropSession(session: number): void {
    this.pending.delete(session)
    const prefix = `${session}:`
    for (const key of this.lastEmittedMs.keys()) {
      if (key.startsWith(prefix)) this.lastEmittedMs.delete(key)
    }
  }

  private pruneStale(session: number): void {
    const queue = this.pending.get(session)
    if (!queue || queue.length === 0) return
    const cutoff = this.now() - STALE_MARK_MS
    const stale: PendingMark[] = []
    const kept: PendingMark[] = []
    for (const mark of queue) {
      ;(mark.startedAtMs < cutoff ? stale : kept).push(mark)
    }
    if (stale.length === 0) return
    if (kept.length === 0) this.pending.delete(session)
    else this.pending.set(session, kept)
    const mostRecentStale = stale[stale.length - 1]
    this.emit(
      session,
      mostRecentStale.cls,
      'round-trip mark abandoned: no frame arrived within the staleness window',
      { staleMarkMs: STALE_MARK_MS, count: stale.length }
    )
  }

  private emit(
    session: number,
    cls: WriteClass,
    message: string,
    extra: Record<string, unknown>
  ): void {
    const key = `${session}:${message}`
    const nowMs = this.now()
    const last = this.lastEmittedMs.get(key)
    if (last !== undefined && nowMs - last < THROTTLE_WINDOW_MS) return
    this.lastEmittedMs.set(key, nowMs)
    this.sink({
      source: 'terminal-transport',
      message,
      payload: { session, class: cls, ...extra }
    })
  }
}
