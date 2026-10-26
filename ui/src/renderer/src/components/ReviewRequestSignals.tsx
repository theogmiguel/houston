import { useEffect } from 'react'
import type { HoustonClient } from '../houston/client'
import type { DesktopNotificationMode } from '../usePreferences'
import { useReviewRequestSummary } from '../houston/useReviewRequests'

/** Mounted lazily by the shell: watches the review-request queue for the rail
 *  count and raises its desktop notice. It renders nothing. */
export function ReviewRequestSignals({
  client,
  desktopNotificationMode,
  onCount
}: {
  client: HoustonClient | null
  desktopNotificationMode: DesktopNotificationMode
  onCount: (count: number) => void
}): null {
  const count = useReviewRequestSummary(client, desktopNotificationMode)
  useEffect(() => {
    onCount(count)
  }, [count, onCount])
  return null
}
