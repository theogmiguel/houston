import type { HoustonClient } from './client'
import { isTauri } from './host'

// The daemon holds phone notifications for DESKTOP_AWAY_SECS after each report, so
// resending at most this often ends the hold 150 to 180 s after the last input.
export const PRESENCE_REPORT_INTERVAL_MS = 30_000
// Focus moving into the docked browser blurs this document, and the browser's focus
// event can arrive just before or just after that blur; within this window they are
// one move inside Houston.
export const BROWSER_FOCUS_GRACE_MS = 500
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'focus'] as const

/** Calls `onFocus` whenever a docked browser surface takes focus; returns the unsubscribe. */
export type BrowserFocusSource = (onFocus: () => void) => () => void

/** The native browser's focus event, sent to the window that docks it. */
export const tauriBrowserFocus: BrowserFocusSource = (onFocus) => {
  let disposed = false
  let unlisten: (() => void) | null = null
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('browser://focus', () => onFocus()))
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    .catch((err: unknown) => console.warn('houston: browser focus is unavailable to desktop presence', err))
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Tells the daemon while someone is using this window, so phone notifications
 *  wait; blur or hiding the window reports away at once. Focus moving into a docked
 *  browser (`browserFocus`) is not away and counts as input. Returns the unsubscribe. */
export function watchDesktopPresence(
  client: Pick<HoustonClient, 'send'>,
  browserFocus?: BrowserFocusSource
): () => void {
  let reportedAt: number | null = null
  let browserFocusAt = Number.NEGATIVE_INFINITY
  let pendingAway: ReturnType<typeof setTimeout> | null = null
  const cancelAway = (): void => {
    if (pendingAway !== null) clearTimeout(pendingAway)
    pendingAway = null
  }
  const report = (): void => {
    const now = Date.now()
    if (reportedAt !== null && now - reportedAt < PRESENCE_REPORT_INTERVAL_MS) return
    reportedAt = now
    client.send({ type: 'desktop_presence', active: true })
  }
  const active = (): void => {
    if (!document.hasFocus() || document.visibilityState !== 'visible') return
    cancelAway()
    report()
  }
  const away = (): void => {
    cancelAway()
    if (reportedAt === null) return
    reportedAt = null
    client.send({ type: 'desktop_presence', active: false })
  }
  const onBlur = (): void => {
    if (!browserFocus) return away()
    if (Date.now() - browserFocusAt < BROWSER_FOCUS_GRACE_MS) return
    cancelAway()
    pendingAway = setTimeout(away, BROWSER_FOCUS_GRACE_MS)
  }
  const onBrowserFocus = (): void => {
    browserFocusAt = Date.now()
    cancelAway()
    if (document.visibilityState === 'visible') report()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') active()
    else away()
  }
  const opts = { capture: true, passive: true }
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, active, opts)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  const stopBrowser = browserFocus?.(onBrowserFocus)
  active()
  return () => {
    cancelAway()
    stopBrowser?.()
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, active, opts)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

/** The watcher for this host: Tauri windows also follow their docked browser. */
export function watchHostDesktopPresence(client: Pick<HoustonClient, 'send'>): () => void {
  return watchDesktopPresence(client, isTauri() ? tauriBrowserFocus : undefined)
}
