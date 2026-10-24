import type { HoustonClient } from './client'

// The daemon holds phone notifications for DESKTOP_AWAY_SECS after each report, so
// resending at most this often ends the hold 150 to 180 s after the last input.
export const PRESENCE_REPORT_INTERVAL_MS = 30_000
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'focus'] as const

/** Tells the daemon while someone is using this window, so phone notifications
 *  wait; blur or hiding the window reports away at once. Returns the unsubscribe. */
export function watchDesktopPresence(client: Pick<HoustonClient, 'send'>): () => void {
  let reportedAt: number | null = null
  const active = (): void => {
    if (!document.hasFocus() || document.visibilityState !== 'visible') return
    const now = Date.now()
    if (reportedAt !== null && now - reportedAt < PRESENCE_REPORT_INTERVAL_MS) return
    reportedAt = now
    client.send({ type: 'desktop_presence', active: true })
  }
  const away = (): void => {
    if (reportedAt === null) return
    reportedAt = null
    client.send({ type: 'desktop_presence', active: false })
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') active()
    else away()
  }
  const opts = { capture: true, passive: true }
  for (const type of ACTIVITY_EVENTS) window.addEventListener(type, active, opts)
  window.addEventListener('blur', away)
  document.addEventListener('visibilitychange', onVisibility)
  active()
  return () => {
    for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, active, opts)
    window.removeEventListener('blur', away)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
