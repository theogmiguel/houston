export function findSafeSplit(data: Uint8Array, maxLen: number): number {
  if (data.length <= maxLen) return data.length

  const ESC = 0x1b
  type State = 'ground' | 'esc' | 'csi' | 'osc' | 'str' | 'utf8'
  let state: State = 'ground'
  let utf8Remaining = 0
  let lastSafe = 0
  let i = 0

  while (i < maxLen) {
    const b = data[i]
    switch (state) {
      case 'ground':
        i++
        if (b === ESC) {
          state = 'esc'
        } else if (b >= 0xc2 && b <= 0xdf) {
          state = 'utf8'
          utf8Remaining = 1
        } else if (b >= 0xe0 && b <= 0xef) {
          state = 'utf8'
          utf8Remaining = 2
        } else if (b >= 0xf0 && b <= 0xf4) {
          state = 'utf8'
          utf8Remaining = 3
        } else {
          lastSafe = i
        }
        break
      case 'utf8':
        if ((b & 0xc0) === 0x80) {
          i++
          utf8Remaining--
          if (utf8Remaining === 0) {
            state = 'ground'
            lastSafe = i
          }
        } else {
          state = 'ground'
        }
        break
      case 'esc':
        i++
        if (b === 0x5b) state = 'csi'
        else if (b === 0x5d) state = 'osc'
        else if (b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
          state = 'str'
        } else {
          state = 'ground'
          lastSafe = i
        }
        break
      case 'csi':
        i++
        if (b >= 0x40 && b <= 0x7e) {
          state = 'ground'
          lastSafe = i
        }
        break
      case 'osc':
        if (b === 0x07) {
          i++
          state = 'ground'
          lastSafe = i
        } else if (b === ESC && data[i + 1] === 0x5c && i + 2 <= maxLen) {
          i += 2
          state = 'ground'
          lastSafe = i
        } else {
          i++
        }
        break
      case 'str':
        if (b === ESC && data[i + 1] === 0x5c && i + 2 <= maxLen) {
          i += 2
          state = 'ground'
          lastSafe = i
        } else {
          i++
        }
        break
    }
  }

  return lastSafe === 0 ? data.length : lastSafe
}

export function findResyncStart(data: Uint8Array): number {
  const end = Math.min(data.length, RESYNC_WINDOW_BYTES)
  for (let i = 0; i < end; i++) {
    if (data[i] === 0x0a) return i + 1
  }
  for (let i = 0; i < end; i++) {
    if (data[i] === 0x1b) return i
  }
  return 0
}

function concatBytes(pieces: Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]
  let total = 0
  for (const p of pieces) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of pieces) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const warningEncoder = new TextEncoder()
function overflowWarning(totalDropped: number): Uint8Array {
  return warningEncoder.encode(
    `\r\n\x1B[33m[houston: dropped ${totalDropped} bytes total of buffered output due to backpressure]\x1B[0m\r\n`
  )
}

function resetDiscardWarning(totalDropped: number): Uint8Array {
  return warningEncoder.encode(
    `\r\n\x1B[33m[houston: discarded ${totalDropped} bytes of pre-reset output that had not yet reached the terminal]\x1B[0m\r\n`
  )
}

interface QueueEntry {
  data: Uint8Array
  isWarning: boolean
  exempt: boolean
}

export interface WriteQueueOptions {
  write: (payload: Uint8Array, callback: () => void) => void
  chunkBytes?: number
  maxQueuedBytes?: number
  watchdogMs?: number
  smallWriteBytes?: number
  batchWindowMs?: number
  isAltBuffer?: () => boolean
  onLossOutOfBand?: (totalDropped: number) => void
  noticeIntervalMs?: number
  dropTargetFraction?: number
}

// 256 KiB is a responsiveness budget, not a memory one: ghostty parses
// synchronously at ~32 ms/MiB, so a chunk is ~8 ms of blocking, half a 60 Hz
// frame, with the queue yielding between chunks. Larger trades latency for throughput.
const DEFAULT_CHUNK_BYTES = 256 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024
const DEFAULT_WATCHDOG_MS = 10_000
const DEFAULT_SMALL_WRITE_BYTES = 1024
const DEFAULT_BATCH_WINDOW_MS = 4
const DEFAULT_NOTICE_INTERVAL_MS = 2000
// A batch timer this late means the host is clamping timers, not that the event
// loop is busy: an order of magnitude above the 4 ms window and below the
// ~1000 ms a throttled host delivers. Tripping it disables batching.
const BATCH_WINDOW_CLAMP_MS = 50
const DEFAULT_DROP_TARGET_FRACTION = 0.75
const RESYNC_WINDOW_BYTES = 8 * 1024

export interface PaneWriteQueueStats {
  writesStarted: number
  completions: number
  staleCompletions: number
  watchdogFires: number
  batchDelayMaxMs: number
  batchWindowsDisabled: number
}

const writeQueueStats: PaneWriteQueueStats = {
  writesStarted: 0,
  completions: 0,
  staleCompletions: 0,
  watchdogFires: 0,
  batchDelayMaxMs: 0,
  batchWindowsDisabled: 0
}
;(
  globalThis as unknown as { __trWriteQueueStats__: PaneWriteQueueStats }
).__trWriteQueueStats__ = writeQueueStats

export class PaneWriteQueue {
  private readonly write: (payload: Uint8Array, callback: () => void) => void
  private readonly chunkBytes: number
  private readonly maxQueuedBytes: number
  private readonly watchdogMs: number
  private readonly smallWriteBytes: number
  private readonly batchWindowMs: number

  private queue: QueueEntry[] = []
  private queuedBytes = 0
  private droppedBytes = 0
  private unannouncedBytes = 0
  private lastNoticeAt = 0
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  private disposed = false
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined
  private watchdogToken = 0
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private batchWindowDisabled = false

  constructor(opts: WriteQueueOptions) {
    this.write = opts.write
    this.chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES
    this.maxQueuedBytes = opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    this.watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS
    this.smallWriteBytes = opts.smallWriteBytes ?? DEFAULT_SMALL_WRITE_BYTES
    this.batchWindowMs = opts.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
    this.isAltBuffer = opts.isAltBuffer ?? (() => false)
    this.onLossOutOfBand = opts.onLossOutOfBand ?? (() => {})
    this.noticeIntervalMs = opts.noticeIntervalMs ?? DEFAULT_NOTICE_INTERVAL_MS
    this.dropTargetFraction = opts.dropTargetFraction ?? DEFAULT_DROP_TARGET_FRACTION
  }

  private readonly isAltBuffer: () => boolean
  private readonly onLossOutOfBand: (totalDropped: number) => void
  private readonly noticeIntervalMs: number
  private readonly dropTargetFraction: number

  get totalDropped(): number {
    return this.droppedBytes
  }

  enqueue(data: Uint8Array, exempt = false): void {
    if (this.disposed || data.length === 0) return
    if (data.length <= this.smallWriteBytes && this.queue.length === 0 && !this.inFlight) {
      this.startWrite(data)
      return
    }
    this.push(data, false, exempt)
    this.schedulePump()
  }

  dispose(): void {
    this.disposed = true
    this.clearWatchdog()
    if (this.noticeTimer !== undefined) {
      clearTimeout(this.noticeTimer)
      this.noticeTimer = undefined
    }
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.queue = []
    this.queuedBytes = 0
  }

  discardPendingForReset(): number {
    const dropped = this.queuedBytes
    this.queue = []
    this.queuedBytes = 0
    if (dropped > 0) {
      this.push(resetDiscardWarning(dropped), true)
      this.pump()
    }
    return dropped
  }

  private push(data: Uint8Array, isWarning = false, exempt = false): void {
    this.queue.push({ data, isWarning, exempt })
    this.queuedBytes += data.length
    if (isWarning || this.queuedBytes <= this.maxQueuedBytes) return

    let dropped = 0
    let i = 0
    const target = this.maxQueuedBytes * this.dropTargetFraction
    while (this.queuedBytes > target && i < this.queue.length) {
      const entry = this.queue[i]
      if (entry.isWarning || entry.exempt) {
        i++
        continue
      }
      this.queue.splice(i, 1)
      this.queuedBytes -= entry.data.length
      dropped += entry.data.length
    }
    if (dropped > 0) {
      this.droppedBytes += dropped
      this.unannouncedBytes += dropped
      this.resyncAfterDrop(i)
      this.announceLoss()
    }
  }

  private resyncAfterDrop(index: number): void {
    const entry = this.queue[index]
    if (!entry || entry.isWarning || entry.exempt) return
    const start = findResyncStart(entry.data)
    if (start <= 0) return
    this.queuedBytes -= start
    this.droppedBytes += start
    this.unannouncedBytes += start
    if (start >= entry.data.length) {
      this.queue.splice(index, 1)
      return
    }
    this.queue[index] = { ...entry, data: entry.data.subarray(start) }
  }

  private announceLoss(): void {
    const now = Date.now()
    if (this.lastNoticeAt !== 0 && now - this.lastNoticeAt < this.noticeIntervalMs) {
      if (this.noticeTimer === undefined) {
        this.noticeTimer = setTimeout(
          () => {
            this.noticeTimer = undefined
            if (this.disposed || this.unannouncedBytes === 0) return
            this.emitLoss()
          },
          this.noticeIntervalMs - (now - this.lastNoticeAt)
        )
      }
      return
    }
    this.emitLoss()
  }

  private emitLoss(): void {
    this.lastNoticeAt = Date.now()
    this.unannouncedBytes = 0
    if (this.isAltBuffer()) {
      this.onLossOutOfBand(this.droppedBytes)
      return
    }
    this.push(overflowWarning(this.droppedBytes), true)
    this.pump()
  }

// A live frame holds the first flush for `batchWindowMs` so a burst merges into
// one write. Every other pump caller flushes immediately: those paths either
// already coalesce or must not wait.
  private schedulePump(): void {
    if (this.inFlight || this.disposed) return
    if (this.batchWindowMs <= 0 || this.batchWindowDisabled) {
      this.pump()
      return
    }
    if (this.batchTimer !== undefined) return
    const armedAt = Date.now()
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      const actual = Date.now() - armedAt
      if (actual > this.batchWindowMs) {
        writeQueueStats.batchDelayMaxMs = Math.max(writeQueueStats.batchDelayMaxMs, actual)
      }
      if (actual >= BATCH_WINDOW_CLAMP_MS) {
        this.batchWindowDisabled = true
        writeQueueStats.batchWindowsDisabled += 1
      }
      this.pump()
    }, this.batchWindowMs)
  }

  private pump(): void {
    if (this.inFlight || this.disposed || this.queue.length === 0) return
    this.startWrite(this.dequeueChunk())
  }

  private dequeueChunk(): Uint8Array {
    let total = 0
    const pieces: QueueEntry[] = []
    while (this.queue.length > 0 && total < this.chunkBytes) {
      const piece = this.queue.shift()!
      this.queuedBytes -= piece.data.length
      pieces.push(piece)
      total += piece.data.length
    }
    const merged = concatBytes(pieces.map((p) => p.data))
    const splitAt = findSafeSplit(merged, this.chunkBytes)
    if (splitAt >= merged.length) return merged

    let restIsWarning = false
    let restIsExempt = false
    let offset = 0
    for (const p of pieces) {
      offset += p.data.length
      if (splitAt < offset && p.isWarning) restIsWarning = true
      if (splitAt < offset && p.exempt) restIsExempt = true
    }
    const rest = merged.slice(splitAt)
    this.queue.unshift({ data: rest, isWarning: restIsWarning, exempt: restIsExempt })
    this.queuedBytes += rest.length
    return merged.subarray(0, splitAt)
  }

  private startWrite(chunk: Uint8Array): void {
    this.inFlight = true
    writeQueueStats.writesStarted += 1
    const token = ++this.watchdogToken
    this.armWatchdog(token)
    this.write(chunk, () => this.onWriteDone(token))
  }

  private onWriteDone(token: number): void {
    if (token !== this.watchdogToken) {
      writeQueueStats.staleCompletions += 1
      return
    }
    writeQueueStats.completions += 1
    this.clearWatchdog()
    this.inFlight = false
    if (!this.disposed) this.pump()
  }

  private armWatchdog(token: number): void {
    this.clearWatchdog()
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = undefined
      if (token !== this.watchdogToken) return
      writeQueueStats.watchdogFires += 1
      this.inFlight = false
      this.pump()
    }, this.watchdogMs)
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = undefined
    }
  }
}
