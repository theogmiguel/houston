// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, listenHandlers } = vi.hoisted(() => {
  const listenHandlers = new Map<string, (event: { payload: unknown }) => void>()
  return {
    invokeMock: vi.fn().mockResolvedValue(undefined),
    listenHandlers,
    listenMock: vi.fn(
      (name: string, handler: (event: { payload: unknown }) => void): Promise<() => void> => {
        listenHandlers.set(name, handler)
        return Promise.resolve(vi.fn())
      }
    )
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import { installWatchdog, requestReload } from './watchdog'

type RafCallback = (time: number) => void

let rafCallbacks: Map<number, RafCallback>
let rafNextId: number

function installFakeRaf(): void {
  rafCallbacks = new Map()
  rafNextId = 1
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: RafCallback): number => {
      const id = rafNextId++
      rafCallbacks.set(id, cb)
      return id
    }
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafCallbacks.delete(id)
  })
}

interface FakeMediaQueryList {
  matches: boolean
  media: string
  addEventListener: (event: string, handler: () => void) => void
  removeEventListener: (event: string, handler: () => void) => void
  _fire: () => void
}

let lastMql: FakeMediaQueryList | null

function installFakeMatchMedia(): void {
  lastMql = null
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string): FakeMediaQueryList => {
      const handlers = new Set<() => void>()
      const fake: FakeMediaQueryList = {
        matches: false,
        media: query,
        addEventListener: (_event, handler) => handlers.add(handler),
        removeEventListener: (_event, handler) => handlers.delete(handler),
        _fire: () => {
          for (const handler of [...handlers]) handler()
        }
      }
      lastMql = fake
      return fake
    })
  )
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

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
  vi.useFakeTimers()
  installFakeRaf()
  installFakeMatchMedia()
  setVisibility('visible')
  document.hasFocus = vi.fn().mockReturnValue(true)
  invokeMock.mockClear()
  listenMock.mockClear()
  listenHandlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setTauriPresent(false)
})

describe('installWatchdog without Tauri (Electron, the shipping app)', () => {
  it('registers nothing at all when __TAURI_INTERNALS__ is absent', async () => {
    setTauriPresent(false)
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener')
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const matchMediaSpy = vi.spyOn(window, 'matchMedia')

    const dispose = installWatchdog()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(6000)

    expect(invokeMock).not.toHaveBeenCalled()
    expect(listenMock).not.toHaveBeenCalled()
    expect(rafSpy).not.toHaveBeenCalled()
    expect(matchMediaSpy).not.toHaveBeenCalled()
    expect(addEventListenerSpy).not.toHaveBeenCalledWith('visibilitychange', expect.anything())

    dispose()
  })
})

describe('installWatchdog paint probe, under Tauri', () => {
  it('reports wd_paint_report with rafGapMs (not raf_gap_ms) when rAF never fires while visible', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(5000)

    expect(invokeMock).toHaveBeenCalledWith('wd_paint_report', {
      ok: false,
      rafGapMs: 5000,
      visibility: 'visible'
    })
    const call = invokeMock.mock.calls.find((c) => c[0] === 'wd_paint_report')
    expect(call?.[1]).toHaveProperty('rafGapMs')
    expect(call?.[1]).not.toHaveProperty('raf_gap_ms')

    dispose()
  })

  it('never reports a paint failure for a hidden page (probe in flight when the page hides)', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(6000)

    expect(invokeMock).not.toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )

    dispose()
  })

  it('warns but does not report when rAF fires past T_warn but before the timeout', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await vi.advanceTimersByTimeAsync(2000)
    const cb = [...rafCallbacks.values()][0]
    rafCallbacks.clear()
    cb?.(2000)
    await flushMicrotasks()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('T_warn'))
    expect(invokeMock).not.toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )

    warnSpy.mockRestore()
    dispose()
  })
})

describe('installWatchdog paint-probe cadence', () => {
  it('waits out the gap after a returned probe instead of re-arming from inside the rAF', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const cb = [...rafCallbacks.values()][0]
    rafCallbacks.clear()
    cb?.(0)
    await flushMicrotasks()
    expect(rafCallbacks.size).toBe(0)

    await vi.advanceTimersByTimeAsync(4999)
    expect(rafCallbacks.size).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(rafCallbacks.size).toBe(1)

    dispose()
  })

  it('re-arms a MISSED probe immediately — the failure path is what the watchdog measures', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    rafCallbacks.clear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(invokeMock).toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )
    expect(rafCallbacks.size).toBe(1)

    dispose()
  })

  it('does not double-arm when focus arrives while a probe is waiting out its gap', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const cb = [...rafCallbacks.values()][0]
    rafCallbacks.clear()
    cb?.(0)
    await flushMicrotasks()

    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('pointerdown'))
    await flushMicrotasks()
    expect(rafCallbacks.size).toBe(0)

    await vi.advanceTimersByTimeAsync(5000)
    expect(rafCallbacks.size).toBe(1)

    dispose()
  })
})

describe('installWatchdog wd:wake / wd:dpr / wd:reload-imminent, under Tauri', () => {
  it('arms the post-wake probe at clamp(suspended_ms/4, 8000, 30000) after wd:wake', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const wakeHandler = listenHandlers.get('wd:wake')
    expect(wakeHandler).toBeDefined()
    wakeHandler?.({ payload: { suspended_ms: 40_000, boot_ms: 0 } })
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(9999)
    expect(invokeMock).not.toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )
    await vi.advanceTimersByTimeAsync(1)
    expect(invokeMock).toHaveBeenCalledWith('wd_paint_report', {
      ok: false,
      rafGapMs: 10_000,
      visibility: 'visible'
    })

    dispose()
  })

  it('wd:reload-imminent only warns; no invoke, no acknowledgement', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handler = listenHandlers.get('wd:reload-imminent')
    expect(handler).toBeDefined()
    handler?.({ payload: { reason: 'test', in_ms: 5000 } })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reload imminent'))
    expect(invokeMock).not.toHaveBeenCalled()

    warnSpy.mockRestore()
    dispose()
  })
})

describe('installWatchdog disposer', () => {
  it('removes its visibilitychange listener and stops probing after disposal', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    dispose()
    invokeMock.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe('installWatchdog PaintStalled recovery (spec §5.1 PaintStalled -> Healthy row)', () => {
  it('reports ok:true, edge-triggered, after a failed probe is followed by a successful one', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(5000)
    expect(invokeMock).toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )
    invokeMock.mockClear()

    let cb = [...rafCallbacks.values()][0]
    rafCallbacks.clear()
    cb?.(0)
    await flushMicrotasks()
    expect(invokeMock).toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: true })
    )
    invokeMock.mockClear()

    cb = [...rafCallbacks.values()][0]
    rafCallbacks.clear()
    cb?.(0)
    await flushMicrotasks()
    expect(invokeMock).not.toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: true })
    )

    dispose()
  })
})

describe('installWatchdog condition 2 — focus/recent interaction (spec §7 row 6)', () => {
  it('never probes while unfocused and uninteracted, and resumes probing after an interaction', async () => {
    setTauriPresent(true)
    document.hasFocus = vi.fn().mockReturnValue(false)
    const dispose = installWatchdog()
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(6000)
    expect(invokeMock).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pointerdown'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5000)
    expect(invokeMock).toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )

    dispose()
  })

  it('resumes probing when the window regains focus, without needing an interaction (spec §7 row 6)', async () => {
    setTauriPresent(true)
    const hasFocusMock = vi.fn().mockReturnValue(false)
    document.hasFocus = hasFocusMock
    const dispose = installWatchdog()
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(6000)
    expect(invokeMock).not.toHaveBeenCalled()

    hasFocusMock.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    await flushMicrotasks()

    await vi.advanceTimersByTimeAsync(5000)
    expect(invokeMock).toHaveBeenCalledWith(
      'wd_paint_report',
      expect.objectContaining({ ok: false })
    )

    dispose()
  })
})

describe('installWatchdog reports the measured gap, not the armed timeout (spec §5.4/§9.5 calibration input, machine.rs ThresholdCrossed)', () => {
  it('reports performance.now() elapsed, which diverges from the armed timeout when the loop was blocked past the deadline', async () => {
    setTauriPresent(true)
    let fakeNow = 0
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)

    const dispose = installWatchdog()
    await flushMicrotasks()

    fakeNow = 8000
    await vi.advanceTimersByTimeAsync(5000)

    expect(invokeMock).toHaveBeenCalledWith('wd_paint_report', {
      ok: false,
      rafGapMs: 8000,
      visibility: 'visible'
    })

    nowSpy.mockRestore()
    dispose()
  })
})

describe('installWatchdog hidden without a visibilitychange event (spec §8.3 item 3)', () => {
  it('does not report when visibilityState reads hidden at timeout time, even without a visibilitychange event', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5000)

    expect(invokeMock).not.toHaveBeenCalled()

    dispose()
  })
})

describe('installWatchdog DPR watcher (spec §8.3 item 4)', () => {
  it('nudges only after the 250ms debounce, not before', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const nudgeSpy = vi.spyOn(document.documentElement, 'getBoundingClientRect')
    lastMql?._fire()

    await vi.advanceTimersByTimeAsync(249)
    expect(nudgeSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(nudgeSpy).toHaveBeenCalledTimes(1)

    nudgeSpy.mockRestore()
    dispose()
  })

  it('re-arms after a change, so a second change on the new query also nudges', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const nudgeSpy = vi.spyOn(document.documentElement, 'getBoundingClientRect')

    lastMql?._fire()
    await vi.advanceTimersByTimeAsync(250)
    expect(nudgeSpy).toHaveBeenCalledTimes(1)

    lastMql?._fire()
    await vi.advanceTimersByTimeAsync(250)
    expect(nudgeSpy).toHaveBeenCalledTimes(2)

    nudgeSpy.mockRestore()
    dispose()
  })

  it('disposer removes the listener and cancels a pending debounce', async () => {
    setTauriPresent(true)
    const dispose = installWatchdog()
    await flushMicrotasks()

    const nudgeSpy = vi.spyOn(document.documentElement, 'getBoundingClientRect')
    lastMql?._fire()

    dispose()
    await vi.advanceTimersByTimeAsync(250)

    expect(nudgeSpy).not.toHaveBeenCalled()

    nudgeSpy.mockRestore()
  })
})

describe('requestReload (spec §8.3 item 6)', () => {
  it('invokes wd_request_reload with the reason under Tauri', async () => {
    setTauriPresent(true)
    await requestReload('user-pressed-reload')

    expect(invokeMock).toHaveBeenCalledWith('wd_request_reload', { reason: 'user-pressed-reload' })
  })

  it('is a no-op when __TAURI_INTERNALS__ is absent', async () => {
    setTauriPresent(false)
    await requestReload('user-pressed-reload')

    expect(invokeMock).not.toHaveBeenCalled()
  })
})
