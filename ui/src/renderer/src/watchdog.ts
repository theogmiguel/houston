import { isTauri } from './houston/host'

const T_PAINT_BASE_MS = 5000
// Re-armed from a timer at the base interval, not from inside the rAF callback:
// re-arming there ran the probe at display refresh (60-165 wakeups/s) for a
// signal that only needs sampling per deadline. A missed deadline re-arms at once.
const PAINT_PROBE_GAP_MS = T_PAINT_BASE_MS
const T_WARN_MS = 1500
const DPR_DEBOUNCE_MS = 250
const POST_WAKE_MIN_MS = 8000
const POST_WAKE_MAX_MS = 30000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function repaintNudge(): void {
  document.documentElement.getBoundingClientRect()
  document.documentElement.style.setProperty('--wd-repaint-nudge', String(performance.now()))
  window.dispatchEvent(new Event('resize'))
}

export function installWatchdog(): () => void {
  if (!isTauri()) {
    return () => {}
  }

  let disposed = false
  const disposers: Array<() => void> = []

  let rafHandle: number | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let gapHandle: ReturnType<typeof setTimeout> | null = null
  let probeScheduledAt = 0

  let lastReportWasFailure = false

  let lastInteractionAt = -Infinity
  function interactedRecently(): boolean {
    return performance.now() - lastInteractionAt <= T_PAINT_BASE_MS
  }

  function clearProbe(): void {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    if (gapHandle !== null) {
      clearTimeout(gapHandle)
      gapHandle = null
    }
  }

  function armPaintProbe(timeoutMs: number, invoke: (typeof import('@tauri-apps/api/core'))['invoke']): void {
    clearProbe()
    if (document.visibilityState !== 'visible') return
    if (!document.hasFocus() && !interactedRecently()) return
    probeScheduledAt = performance.now()
    rafHandle = requestAnimationFrame(() => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      rafHandle = null
      const gap = performance.now() - probeScheduledAt
      if (gap > T_WARN_MS) {
        console.warn(`watchdog: rAF gap ${gap.toFixed(0)}ms exceeded T_warn (${T_WARN_MS}ms)`)
      }
      if (lastReportWasFailure) {
        lastReportWasFailure = false
        invoke('wd_paint_report', {
          ok: true,
          rafGapMs: Math.round(gap),
          visibility: 'visible'
        }).catch((err: unknown) => {
          console.warn('watchdog: wd_paint_report invoke failed', err)
        })
      }
      gapHandle = setTimeout(() => {
        gapHandle = null
        armPaintProbe(T_PAINT_BASE_MS, invoke)
      }, PAINT_PROBE_GAP_MS)
    })
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      if (document.visibilityState === 'visible' && (document.hasFocus() || interactedRecently())) {
        invoke('wd_paint_report', {
          ok: false,
          rafGapMs: Math.round(performance.now() - probeScheduledAt),
          visibility: 'visible'
        }).catch((err: unknown) => {
          console.warn('watchdog: wd_paint_report invoke failed', err)
        })
        lastReportWasFailure = true
      }
      armPaintProbe(T_PAINT_BASE_MS, invoke)
    }, timeoutMs)
  }

  void (async (): Promise<void> => {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event')
    ])
    if (disposed) return

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        clearProbe()
      } else {
        armPaintProbe(T_PAINT_BASE_MS, invoke)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

    const unlistenWake = await listen<{ suspended_ms: number; boot_ms: number }>(
      'wd:wake',
      (event) => {
        repaintNudge()
        armPaintProbe(clamp(event.payload.suspended_ms / 4, POST_WAKE_MIN_MS, POST_WAKE_MAX_MS), invoke)
      }
    )
    if (disposed) {
      unlistenWake()
      return
    }
    disposers.push(unlistenWake)

    const unlistenDpr = await listen<{ scale_factor: number }>('wd:dpr', () => {
      repaintNudge()
    })
    if (disposed) {
      unlistenDpr()
      return
    }
    disposers.push(unlistenDpr)

    const unlistenReloadImminent = await listen<{ reason: string; in_ms: number }>(
      'wd:reload-imminent',
      (event) => {
        console.warn(
          `watchdog: reload imminent in ${event.payload.in_ms}ms (reason: ${event.payload.reason})`
        )
      }
    )
    if (disposed) {
      unlistenReloadImminent()
      return
    }
    disposers.push(unlistenReloadImminent)

    function onInteraction(): void {
      lastInteractionAt = performance.now()
      if (rafHandle === null && timeoutHandle === null && gapHandle === null) {
        armPaintProbe(T_PAINT_BASE_MS, invoke)
      }
    }
    window.addEventListener('pointerdown', onInteraction, { passive: true })
    window.addEventListener('keydown', onInteraction, { passive: true })
    window.addEventListener('wheel', onInteraction, { passive: true })

    function onFocus(): void {
      if (rafHandle === null && timeoutHandle === null && gapHandle === null) {
        armPaintProbe(T_PAINT_BASE_MS, invoke)
      }
    }
    window.addEventListener('focus', onFocus)

    disposers.push(() => {
      window.removeEventListener('pointerdown', onInteraction)
      window.removeEventListener('keydown', onInteraction)
      window.removeEventListener('wheel', onInteraction)
      window.removeEventListener('focus', onFocus)
    })

    armPaintProbe(T_PAINT_BASE_MS, invoke)

    let mql: MediaQueryList | null = null
    let dprDebounce: ReturnType<typeof setTimeout> | null = null
// Fractional DPR changes emit no native scale-factor event, so this
// matchMedia(`resolution: Ndppx`) watcher is the only catch; it is re-armed
// after each change because the query is pinned to the current ratio.
    function armDprWatcher(): void {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onDprChange)
    }
    function onDprChange(): void {
      mql?.removeEventListener('change', onDprChange)
      if (dprDebounce !== null) clearTimeout(dprDebounce)
      dprDebounce = setTimeout(() => {
        dprDebounce = null
        repaintNudge()
        if (!disposed) armDprWatcher()
      }, DPR_DEBOUNCE_MS)
    }
    armDprWatcher()
    disposers.push(() => {
      mql?.removeEventListener('change', onDprChange)
      if (dprDebounce !== null) clearTimeout(dprDebounce)
    })
  })()

  return () => {
    disposed = true
    clearProbe()
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }
}

export async function requestReload(reason: string): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('wd_request_reload', { reason })
}
