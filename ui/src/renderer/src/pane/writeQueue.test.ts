import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findSafeSplit, PaneWriteQueue } from './writeQueue'

const enc = new TextEncoder()
const dec = new TextDecoder()

function bytes(s: string): Uint8Array {
  return enc.encode(s)
}

describe('findSafeSplit', () => {
  it('returns the full length when data already fits', () => {
    const data = bytes('hello')
    expect(findSafeSplit(data, 256)).toBe(data.length)
  })

  it('splits at maxLen when the boundary lands on plain text', () => {
    const data = bytes('a'.repeat(300))
    expect(findSafeSplit(data, 256)).toBe(256)
  })

  it('backs off before a CSI sequence straddling the boundary', () => {
    const prefix = 'x'.repeat(250)
    const csi = '\x1b[38;5;196m'
    const data = bytes(prefix + csi + 'rest')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(250)
    const chunk = data.subarray(0, split)
    expect(dec.decode(chunk)).not.toContain('\x1b[38')
  })

  it('backs off before an OSC sequence (BEL-terminated) straddling the boundary', () => {
    const prefix = 'y'.repeat(250)
    const osc = '\x1b]0;window title' + '\x07'
    const data = bytes(prefix + osc + 'tail')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(250)
  })

  it('backs off before an OSC sequence (ST-terminated) straddling the boundary', () => {
    const prefix = 'z'.repeat(250)
    const osc = '\x1b]0;window title\x1b\\'
    const data = bytes(prefix + osc + 'tail')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(250)
  })

  it('never splits a bare 2-byte escape sequence', () => {
    const prefix = 'w'.repeat(255)
    const data = bytes(prefix + '\x1bc' + 'more')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(255)
  })

  it('hands back the whole buffer unsplit if a sequence never closes', () => {
    const data = bytes('\x1b[' + '1;'.repeat(200))
    expect(findSafeSplit(data, 64)).toBe(data.length)
  })

  it('backs off before a 3-byte UTF-8 codepoint straddling the boundary', () => {
    const prefix = 'x'.repeat(255)
    const data = bytes(prefix + '€' + 'tail')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(255)
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, split))
    ).not.toThrow()
    expect(data[split]).toBe(0xe2)
  })

  it('backs off before a 4-byte UTF-8 codepoint straddling the boundary', () => {
    const prefix = 'x'.repeat(254)
    const data = bytes(prefix + '😀' + 'tail')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(254)
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, split))
    ).not.toThrow()
    expect(data[split]).toBe(0xf0)
  })

  it('cuts normally at maxLen when a UTF-8 codepoint appears earlier but well clear of the boundary', () => {
    const data = bytes('€'.repeat(10) + 'a'.repeat(300))
    expect(findSafeSplit(data, 256)).toBe(256)
  })

  it('resyncs after an invalid UTF-8 continuation byte instead of treating the rest as perpetually open', () => {
    const data = new Uint8Array([0xe2, ...bytes('x'.repeat(300))])
    expect(findSafeSplit(data, 256)).toBe(256)
  })

  it('backs off before a 2-byte UTF-8 codepoint straddling the boundary', () => {
    const prefix = 'x'.repeat(255)
    const data = bytes(prefix + 'é' + 'tail')
    const split = findSafeSplit(data, 256)
    expect(split).toBeLessThanOrEqual(255)
    expect(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, split))
    ).not.toThrow()
    expect(data[split]).toBe(0xc3)
  })

  it('resyncs (and defers the whole buffer) when a bogus UTF-8 lead byte is immediately followed by an unterminated CSI sequence', () => {
    const data = new Uint8Array([0xe2, 0x1b, 0x5b, ...bytes('1;'.repeat(140))])
    expect(data.length).toBe(283)
    expect(findSafeSplit(data, 256)).toBe(283)
  })
})

describe('PaneWriteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('bypasses the queue for a small write with nothing queued', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      write: (payload, cb) => {
        calls.push(payload)
        cb()
      }
    })
    q.enqueue(bytes('hi'))
    expect(calls.length).toBe(1)
    expect(dec.decode(calls[0])).toBe('hi')
  })

  it('delivers a CSI/OSC sequence straddling a 256 KiB boundary intact across chunks', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      write: (payload, cb) => {
        calls.push(payload)
        queueMicrotask(cb)
      }
    })
    const chunk = 256 * 1024
    const prefix = 'a'.repeat(chunk - 5)
    const csi = '\x1b[38;5;201m'
    const payload = bytes(prefix + csi + 'DONE')
    q.enqueue(payload)
    return vi.runAllTimersAsync().then(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const full = dec.decode(concat(calls))
      expect(full).toBe(prefix + csi + 'DONE')
      for (const c of calls) {
        const s = dec.decode(c)
        const escIdx = s.indexOf('\x1b[')
        if (escIdx === -1) continue
        const rest = s.slice(escIdx)
        expect(/\x1b\[[0-9;]*[a-zA-Z]/.test(rest)).toBe(true)
      }
    })
  })

  it('writes at most one chunk at a time, advancing only from the completion callback', async () => {
    const pending: Array<() => void> = []
    const writeCalls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 10,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        writeCalls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('0123456789ABCDEFGHIJ'))
    expect(writeCalls.length).toBe(1)
    expect(dec.decode(writeCalls[0])).toBe('0123456789')
    expect(writeCalls.length).toBe(1)
    q.enqueue(bytes('KLMNO'))
    expect(writeCalls.length).toBe(1)
    pending.shift()!()
    expect(writeCalls.length).toBe(2)
    expect(dec.decode(writeCalls[1])).toBe('ABCDEFGHIJ')
    pending.shift()!()
    expect(writeCalls.length).toBe(3)
    expect(dec.decode(writeCalls[2])).toBe('KLMNO')
  })

  it('recovers a lost write callback via the watchdog and resumes draining', () => {
    const calls: Uint8Array[] = []
    const callbacks: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 5,
      smallWriteBytes: 0,
      watchdogMs: 10_000,
      write: (payload, cb) => {
        calls.push(payload)
        callbacks.push(cb)
      }
    })
    q.enqueue(bytes('AAAAABBBBB'))
    expect(calls.length).toBe(1)
    vi.advanceTimersByTime(9_999)
    expect(calls.length).toBe(1)
    vi.advanceTimersByTime(2)
    expect(calls.length).toBe(2)
    expect(dec.decode(calls[1])).toBe('BBBBB')
  })

  it('ignores a stale callback after the watchdog already recovered its slot', () => {
    const calls: Uint8Array[] = []
    const callbacks: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 5,
      smallWriteBytes: 0,
      watchdogMs: 10_000,
      write: (payload, cb) => {
        calls.push(payload)
        callbacks.push(cb)
      }
    })
    q.enqueue(bytes('AAAAABBBBB'))
    vi.advanceTimersByTime(10_000)
    expect(calls.length).toBe(2)
    expect(() => callbacks[0]()).not.toThrow()
    expect(calls.length).toBe(2)
  })

  it('drops the oldest queued bytes on overflow and writes a visible warning', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 1024,
      maxQueuedBytes: 100,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('A'.repeat(50)))
    q.enqueue(bytes('B'.repeat(60)))
    q.enqueue(bytes('C'.repeat(60)))
    expect(q.totalDropped).toBe(60)

    while (pending.length > 0) pending.shift()!()
    const rest = dec.decode(concat(calls.slice(1)))
    expect(rest).not.toContain('B')
    expect(rest).toContain('C'.repeat(60))
    expect(rest).toContain(
      '\r\n\x1B[33m[houston: dropped 60 bytes total of buffered output due to backpressure]\x1B[0m\r\n'
    )
  })

  it('protects an already-queued warning from being discarded by a later overflow', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 60,
      maxQueuedBytes: 100,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('A'.repeat(50)))
    q.enqueue(bytes('B'.repeat(60)))
    q.enqueue(bytes('C'.repeat(60)))
    expect(q.totalDropped).toBe(60)

    pending.shift()!()
    expect(calls.length).toBe(2)
    expect(dec.decode(calls[1])).toBe('C'.repeat(60))

    q.enqueue(bytes('D'.repeat(20)))
    expect(q.totalDropped).toBe(80)

    while (pending.length > 0) pending.shift()!()
    const rest = dec.decode(concat(calls.slice(2)))
    expect(rest).not.toContain('D')
    expect(rest).toContain(
      '\r\n\x1B[33m[houston: dropped 60 bytes total of buffered output due to backpressure]\x1B[0m\r\n'
    )
    expect(rest).not.toContain('dropped 80 bytes total')
  })

  it('announces the tail of an episode even when nothing else is dropped after it', () => {
    vi.useFakeTimers()
    try {
      const calls: Uint8Array[] = []
      const pending: Array<() => void> = []
      const q = new PaneWriteQueue({
        batchWindowMs: 0,
        chunkBytes: 1000,
        maxQueuedBytes: 100,
        smallWriteBytes: 0,
        noticeIntervalMs: 2000,
        write: (payload, cb) => {
          calls.push(payload)
          pending.push(cb)
        }
      })
      q.enqueue(bytes('A'.repeat(80)))
      q.enqueue(bytes('B'.repeat(80)))
      q.enqueue(bytes('C'.repeat(80)))
      expect(q.totalDropped).toBeGreaterThan(0)
      const droppedAfterFirst = q.totalDropped

      vi.advanceTimersByTime(100)
      q.enqueue(bytes('D'.repeat(80)))
      expect(q.totalDropped).toBeGreaterThan(droppedAfterFirst)

      while (pending.length > 0) pending.shift()!()
      const drained = dec.decode(concat(calls))
      expect(drained.match(/due to backpressure/g)?.length).toBe(1)

      calls.length = 0
      vi.advanceTimersByTime(2100)
      while (pending.length > 0) pending.shift()!()
      expect(dec.decode(concat(calls))).toContain(
        `dropped ${q.totalDropped} bytes total`
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a loss out of band rather than writing into an alternate-screen TUI', () => {
    const calls: Uint8Array[] = []
    const outOfBand: number[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 1000,
      maxQueuedBytes: 100,
      smallWriteBytes: 0,
      isAltBuffer: () => true,
      onLossOutOfBand: (total) => outOfBand.push(total),
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('A'.repeat(80)))
    q.enqueue(bytes('B'.repeat(80)))
    q.enqueue(bytes('C'.repeat(80)))
    while (pending.length > 0) pending.shift()!()

    expect(outOfBand.length).toBe(1)
    expect(outOfBand[0]).toBe(q.totalDropped)
    expect(dec.decode(concat(calls))).not.toContain('houston: dropped')
  })

  it('never hands the parser a stream that starts mid-escape-sequence', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 1000,
      maxQueuedBytes: 100,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('A'.repeat(90)))
    q.enqueue(bytes('X'.repeat(90)))
    q.enqueue(bytes('[t garbage\nreal output here'))
    while (pending.length > 0) pending.shift()!()

    const written = dec.decode(concat(calls))
    expect(written).not.toContain('[t garbage')
    expect(written).toContain('real output here')
  })

  it('does not pin the merged buffer behind a small residual carried to the next chunk', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 256,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        cb()
      }
    })
    const prefix = 'x'.repeat(250)
    const csi = '\x1b[38;5;196m'
    q.enqueue(bytes(prefix + csi + 'tail'))
    expect(calls.length).toBe(2)
    const residualChunk = calls[1]
    expect(residualChunk.byteLength).toBe(15)
    expect(residualChunk.buffer.byteLength).toBe(residualChunk.byteLength)
  })

  it('delivers a >2 MiB exempt replay whole, with zero drops (attach-time catch-up bypasses the cap)', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      write: (payload, cb) => {
        calls.push(payload)
        queueMicrotask(cb)
      }
    })
    const replay = bytes('R'.repeat(3 * 1024 * 1024))
    q.enqueue(replay, true)
    return vi.runAllTimersAsync().then(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(q.totalDropped).toBe(0)
      const full = concat(calls)
      expect(full.length).toBe(replay.length)
      expect(dec.decode(full)).toBe(dec.decode(replay))
    })
  })

  it('flushes a >2 MiB pending-frame catch-up via the exempt path without dropping anything', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      write: (payload, cb) => {
        calls.push(payload)
        queueMicrotask(cb)
      }
    })
    const frame1 = bytes('P'.repeat(1.5 * 1024 * 1024))
    const frame2 = bytes('Q'.repeat(1.5 * 1024 * 1024))
    q.enqueue(frame1, true)
    q.enqueue(frame2, true)
    return vi.runAllTimersAsync().then(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(q.totalDropped).toBe(0)
      const full = dec.decode(concat(calls))
      expect(full).toBe(dec.decode(frame1) + dec.decode(frame2))
    })
  })

  it('still drops steady-state live output exceeding the cap and still warns (cap is not disabled)', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 1024,
      maxQueuedBytes: 100,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('A'.repeat(50)))
    q.enqueue(bytes('B'.repeat(60)), false)
    q.enqueue(bytes('C'.repeat(60)), false)
    expect(q.totalDropped).toBe(60)

    while (pending.length > 0) pending.shift()!()
    const rest = dec.decode(concat(calls.slice(1)))
    expect(rest).not.toContain('B')
    expect(rest).toContain(
      '\r\n\x1B[33m[houston: dropped 60 bytes total of buffered output due to backpressure]\x1B[0m\r\n'
    )
  })

  it('preserves FIFO order when exempt and non-exempt writes interleave', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 0,
      chunkBytes: 4,
      maxQueuedBytes: 1_000_000,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('1111'), true)
    q.enqueue(bytes('2222'), false)
    q.enqueue(bytes('3333'), true)
    q.enqueue(bytes('4444'), false)

    while (pending.length > 0) pending.shift()!()
    const full = dec.decode(concat(calls))
    expect(full).toBe('1111' + '2222' + '3333' + '4444')
  })
})

describe('PaneWriteQueue batch window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('merges a burst arriving within the window into one write', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 4,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        cb()
      }
    })
    q.enqueue(bytes('aaaa'))
    q.enqueue(bytes('bbbb'))
    q.enqueue(bytes('cccc'))
    expect(calls.length).toBe(0)
    vi.advanceTimersByTime(4)
    expect(calls.length).toBe(1)
    expect(dec.decode(calls[0])).toBe('aaaabbbbcccc')
  })

  it('keeps the small-write bypass at zero added latency', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 4,
      write: (payload, cb) => {
        calls.push(payload)
        cb()
      }
    })
    q.enqueue(bytes('echo'))
    expect(calls.length).toBe(1)
  })

  it('does not delay drain after a completed write', () => {
    const calls: Uint8Array[] = []
    const pending: Array<() => void> = []
    const q = new PaneWriteQueue({
      batchWindowMs: 4,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        pending.push(cb)
      }
    })
    q.enqueue(bytes('aaaa'))
    vi.advanceTimersByTime(4)
    expect(calls.length).toBe(1)
    q.enqueue(bytes('bbbb'))
    pending.shift()!()
    expect(calls.length).toBe(2)
    expect(dec.decode(calls[1])).toBe('bbbb')
  })

  it('a disposed queue never flushes a pending window', () => {
    const calls: Uint8Array[] = []
    const q = new PaneWriteQueue({
      batchWindowMs: 4,
      smallWriteBytes: 0,
      write: (payload, cb) => {
        calls.push(payload)
        cb()
      }
    })
    q.enqueue(bytes('aaaa'))
    q.dispose()
    vi.advanceTimersByTime(10)
    expect(calls.length).toBe(0)
  })
})

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

describe('batch window under a clamping host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function bigChunk(): Uint8Array {
    return new Uint8Array(4096).fill(0x61)
  }

  it('keeps batching while the host honours the window', () => {
    const writes: Uint8Array[] = []
    const q = new PaneWriteQueue({
      write: (payload, done) => {
        writes.push(payload)
        done()
      },
      batchWindowMs: 4
    })

    const started = Date.now()
    let now = started
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    q.enqueue(bigChunk())
    expect(writes).toHaveLength(0)
    now = started + 4
    vi.advanceTimersByTime(4)
    expect(writes).toHaveLength(1)

    q.enqueue(bigChunk())
    expect(writes).toHaveLength(1)
    vi.advanceTimersByTime(4)
    expect(writes).toHaveLength(2)
  })

  it('latches the window off after the timer comes back ~1 s late', () => {
    const writes: Uint8Array[] = []
    const q = new PaneWriteQueue({
      write: (payload, done) => {
        writes.push(payload)
        done()
      },
      batchWindowMs: 4
    })

    const started = Date.now()
    let now = started
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    q.enqueue(bigChunk())
    expect(writes).toHaveLength(0)
    now = started + 1000
    vi.advanceTimersByTime(4)
    expect(writes).toHaveLength(1)

    q.enqueue(bigChunk())
    expect(writes).toHaveLength(2)
  })

  it('reports the clamp in the cross-pane stats', () => {
    const before = (
      globalThis as unknown as { __trWriteQueueStats__: { batchWindowsDisabled: number } }
    ).__trWriteQueueStats__.batchWindowsDisabled
    const q = new PaneWriteQueue({ write: (_p, done) => done(), batchWindowMs: 4 })
    const started = Date.now()
    let now = started
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    q.enqueue(bigChunk())
    now = started + 1000
    vi.advanceTimersByTime(4)
    const stats = (
      globalThis as unknown as {
        __trWriteQueueStats__: { batchWindowsDisabled: number; batchDelayMaxMs: number }
      }
    ).__trWriteQueueStats__
    expect(stats.batchWindowsDisabled).toBe(before + 1)
    expect(stats.batchDelayMaxMs).toBeGreaterThanOrEqual(1000)
  })
})
