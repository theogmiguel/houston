import { useEffect } from 'react'
import type { HoustonClient } from './houston/client'
import type { DesktopNotificationMode } from './usePreferences'
import type { ReviewRequestMode } from './houston/generated/ReviewRequestMode'
import type { ServerMsg } from './houston/generated/ServerMsg'
import { isFocused, notifyNative } from './houston/bridge'

type ReviewRequestNotice = Extract<ServerMsg, { type: 'review_request_notice' }>

export function reviewRequestNoticeText(msg: ReviewRequestNotice): { title: string; body: string } {
  return {
    title: 'Review requested',
    body: `${msg.repo}#${msg.number} · ${msg.title} · Tier ${msg.tier.toUpperCase()}`
  }
}

/** Desktop notifications only when the user asked for them and the queue is on. */
export function reviewRequestShouldNotify(mode: ReviewRequestMode, desktopMode: DesktopNotificationMode): boolean {
  if (mode === 'off') return false
  return desktopMode === 'notifications' || desktopMode === 'notifications-sound'
}

/** A new triaged request raises one desktop notification while the window is
 *  unfocused. The daemon sends none for the first run that absorbs existing
 *  requests, and none at all while the queue is off. */
export function useReviewRequestNotice(
  client: HoustonClient | null,
  mode: ReviewRequestMode | null,
  desktopMode: DesktopNotificationMode
): void {
  useEffect(() => {
    if (!client || mode === null || !reviewRequestShouldNotify(mode, desktopMode)) return
    let cancelled = false
    const off = client.subscribe('review_request_notice', (msg) => {
      void isFocused()
        .then((focused) => {
          if (cancelled || focused) return
          const text = reviewRequestNoticeText(msg)
          return notifyNative(text.title, text.body, 0)
        })
        .catch(() => {
          // A refused desktop notification never blocks the queue.
        })
    })
    return () => {
      cancelled = true
      off()
    }
  }, [client, mode, desktopMode])
}
