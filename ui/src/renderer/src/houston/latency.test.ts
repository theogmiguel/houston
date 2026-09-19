// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BULK_THRESHOLD_CHARS,
  ROUND_TRIP_THRESHOLD_MS,
  STALE_MARK_MS,
  THROTTLE_WINDOW_MS,
  WRITE_THRESHOLD_MS,
  WriteLatencyTracker,
  classifyWrite,
  logTerminalTransport,
  type LogPayload
} from './latency'

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

describe('classifyWrite', () => {
  it('classifies enter distinctly from interactive', () => {
    expect(classifyWrite('\r')).toBe('enter')
    expect(classifyWrite('\n')).toBe('enter')
    expect(classifyWrite('\r\n')).toBe('enter')
    expect(classifyWrite('a')).toBe('interactive')
  })

  it('classifies backspace/DEL distinctly from interactive', () => {
    expect(classifyWrite('\x7f')).toBe('backspace')
    expect(classifyWrite('\b')).toBe('backspace')
    expect(classifyWrite('a')).toBe('interactive')
  })

  it('classifies a single printable character as interactive', () => {
    expect(classifyWrite('a')).toBe('interactive')
    expect(classifyWrite('Z')).toBe('interactive')
  })

  it('classifies control bytes and escape-prefixed sequences as control', () => {
    expect(classifyWrite('\x03')).toBe('control')
    expect(classifyWrite('\t')).toBe('control')
    expect(classifyWrite('\x1b[A')).toBe('control')
    expect(classifyWrite('\x1bc')).toBe('control')
  })

  it('classifies a bracketed-paste write as paste regardless of length', () => {
    expect(classifyWrite('\x1b[200~hello\x1b[201~')).toBe('paste')
    expect(classifyWrite('\x1b[200~x')).toBe('paste')
  })

  it('holds the interactive/bulk boundary exactly at BULK_THRESHOLD_CHARS', () => {
    const atBoundary = 'a'.repeat(BULK_THRESHOLD_CHARS)
    const overBoundary = 'a'.repeat(BULK_THRESHOLD_CHARS + 1)
    expect(classifyWrite(atBoundary)).toBe('interactive')
    expect(classifyWrite(overBoundary)).toBe('bulk')
  })

  it('classifies large output/paste-like writes as bulk', () => {
    expect(classifyWrite('x'.repeat(500))).toBe('bulk')
  })

  it('classifies standard xterm CSI function/navigation keys as control even though they exceed BULK_THRESHOLD_CHARS', () => {
    expect(classifyWrite('\x1b[15~')).toBe('control')
    expect(classifyWrite('\x1b[24~')).toBe('control')
    expect(classifyWrite('\x1b[1;5D')).toBe('control')
  })
})

function collectingSink(): { entries: LogPayload[]; sink: (e: LogPayload) => void } {
  const entries: LogPayload[] = []
  return { entries, sink: (e) => entries.push(e) }
}

describe('WriteLatencyTracker', () => {
  it('emits exactly one slow-round-trip record for a slow round trip, and nothing for a second identical event inside the throttle window', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)

    expect(entries.length).toBe(1)
    expect(entries[0].source).toBe('terminal-transport')
    expect(entries[0].payload.class).toBe('interactive')
    expect(entries[0].payload.roundTripMs).toBe(ROUND_TRIP_THRESHOLD_MS + 10)

    tracker.recordWrite(1, 'b', 1)
    t += ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)
  })

  it('does not flag a fast round trip', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(0)
  })

  it('flags a slow write call independently of round-trip time', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', WRITE_THRESHOLD_MS + 1)
    expect(entries.length).toBe(1)
    expect(entries[0].message).toBe('slow write call')
    expect(entries[0].payload.writeDurationMs).toBe(WRITE_THRESHOLD_MS + 1)

    t = 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)
  })

  it('does not open a round-trip mark for a bulk write', () => {
    let t = 0
    const now = (): number => t
    const tracker = new WriteLatencyTracker({ now, sink: () => {} })

    tracker.recordWrite(1, 'x'.repeat(500), 1)
    expect(tracker.pendingMarkCount(1)).toBe(0)
  })

  it('closes marks in FIFO order and does not let one session close another session\'s mark', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = 5
    tracker.recordWrite(2, 'b', 1)

    t = 50
    tracker.closeOnFrame(2)
    expect(entries.length).toBe(0)
    expect(tracker.pendingMarkCount(1)).toBe(1)
    expect(tracker.pendingMarkCount(2)).toBe(0)

    t = ROUND_TRIP_THRESHOLD_MS + 100
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)
    expect(entries[0].payload.session).toBe(1)
  })

  it('closes the oldest pending mark first when a session has several in flight', () => {
    let t = 0
    const now = (): number => t
    const tracker = new WriteLatencyTracker({ now, sink: () => {} })

    tracker.recordWrite(1, 'a', 1)
    t = 1
    tracker.recordWrite(1, 'b', 1)
    expect(tracker.pendingMarkCount(1)).toBe(2)

    tracker.closeOnFrame(1)
    expect(tracker.pendingMarkCount(1)).toBe(1)
    tracker.closeOnFrame(1)
    expect(tracker.pendingMarkCount(1)).toBe(0)
  })

  it('throttles per (session, message) pair, not globally: a different session is unaffected', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)

    tracker.recordWrite(2, 'a', 1)
    t += ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(2)
    expect(entries.length).toBe(2)
    expect(entries[1].payload.session).toBe(2)
  })

  it('throttles per (session, message) pair, not globally: a different message on the same session is unaffected', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)

    tracker.recordWrite(1, 'b', WRITE_THRESHOLD_MS + 1)
    expect(entries.length).toBe(2)
    expect(entries[1].message).toBe('slow write call')
  })

  it('re-emits after the throttle window elapses', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(1)

    t += THROTTLE_WINDOW_MS + 1
    tracker.recordWrite(1, 'a', 1)
    t += ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(2)
  })

  it('evicts the oldest pending mark once the per-session cap is exceeded, and reports it', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    for (let i = 0; i < 20; i++) {
      t += 1
      tracker.recordWrite(1, 'a', 1)
    }
    expect(tracker.pendingMarkCount(1)).toBeLessThanOrEqual(8)
    const capEvictions = entries.filter((e) =>
      e.message.includes('exceeded its cap')
    )
    expect(capEvictions.length).toBeGreaterThan(0)
    expect(capEvictions[0].payload.cap).toBeDefined()
  })

  it('prunes a mark whose frame never arrives once it goes stale, and reports it', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    expect(tracker.pendingMarkCount(1)).toBe(1)

    t = STALE_MARK_MS + 1
    tracker.recordWrite(1, 'b', 1)

    expect(tracker.pendingMarkCount(1)).toBe(1)
    const staleReports = entries.filter((e) => e.message.includes('abandoned'))
    expect(staleReports.length).toBe(1)
    expect(staleReports[0].payload.staleMarkMs).toBe(STALE_MARK_MS)
  })

  it('dropSession removes both the pending-mark queue and every throttle entry for that session, leaving other sessions untouched', () => {
    let t = 0
    const now = (): number => t
    const { entries, sink } = collectingSink()
    const tracker = new WriteLatencyTracker({ now, sink })

    tracker.recordWrite(1, 'a', 1)
    t = ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    tracker.recordWrite(1, 'b', 1)
    expect(tracker.pendingMarkCount(1)).toBe(1)

    tracker.recordWrite(2, 'a', 1)
    t += ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(2)
    const entriesBeforeDrop = entries.length

    tracker.dropSession(1)

    expect(tracker.pendingMarkCount(1)).toBe(0)
    tracker.recordWrite(1, 'c', 1)
    t += ROUND_TRIP_THRESHOLD_MS + 10
    tracker.closeOnFrame(1)
    expect(entries.length).toBe(entriesBeforeDrop + 1)

    expect(tracker.pendingMarkCount(2)).toBe(0)
  })

  it('bounds pending marks under sustained writes with no frames ever arriving (no leak)', () => {
    let t = 0
    const now = (): number => t
    const tracker = new WriteLatencyTracker({ now, sink: () => {} })

    for (let i = 0; i < 500; i++) {
      t += 1
      tracker.recordWrite(1, 'a', 1)
    }
    expect(tracker.pendingMarkCount(1)).toBeLessThanOrEqual(8)
  })
})

describe('logTerminalTransport seam', () => {
  it('is a plain function so item 9 can swap its body for an invoke() call', async () => {
    const mod = await import('./latency')
    expect(typeof mod.logTerminalTransport).toBe('function')
  })

  function setTauriPresent(present: boolean): void {
    const win = window as unknown as { __TAURI_INTERNALS__?: unknown }
    if (present) {
      win.__TAURI_INTERNALS__ = {}
    } else {
      delete win.__TAURI_INTERNALS__
    }
  }

  async function flushMicrotasks(): Promise<void> {
    await vi.dynamicImportSettled()
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  beforeEach(() => {
    invokeMock.mockClear()
    invokeMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    setTauriPresent(false)
    vi.restoreAllMocks()
  })

  it('is a no-op past console.debug when __TAURI_INTERNALS__ is absent (the Electron/WS path)', () => {
    setTauriPresent(false)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    logTerminalTransport({ source: 'terminal-transport', message: 'hi', payload: { a: 1 } })
    expect(debugSpy).toHaveBeenCalledWith('[terminal-transport] hi', { a: 1 })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('sends exactly the three expected arguments to system_log_debug on a successful invoke, and still logs to console.debug', async () => {
    setTauriPresent(true)
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const payload = { session: 1, class: 'bulk' }

    logTerminalTransport({ source: 'terminal-transport', message: 'slow round trip', payload })

    expect(debugSpy).toHaveBeenCalledWith('[terminal-transport] slow round trip', payload)

    await flushMicrotasks()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('system_log_debug', {
      source: 'terminal-transport',
      message: 'slow round trip',
      payload
    })
  })

  it('does not throw and leaves no unhandled rejection when the invoke call itself rejects', async () => {
    setTauriPresent(true)
    invokeMock.mockRejectedValueOnce(new Error('backend refused'))
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      logTerminalTransport({ source: 'terminal-transport', message: 'hi', payload: {} })
    ).not.toThrow()
    expect(debugSpy).toHaveBeenCalledWith('[terminal-transport] hi', {})

    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('logTerminalTransport: system_log_debug invoke failed')
  })

  it('does not throw and leaves no unhandled rejection when the dynamic import of the invoke module itself fails', async () => {
    setTauriPresent(true)
    vi.doMock('@tauri-apps/api/core', () => {
      throw new Error('module failed to load')
    })
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      logTerminalTransport({ source: 'terminal-transport', message: 'hi', payload: {} })
    ).not.toThrow()
    expect(debugSpy).toHaveBeenCalledWith('[terminal-transport] hi', {})

    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('logTerminalTransport: system_log_debug invoke failed')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
