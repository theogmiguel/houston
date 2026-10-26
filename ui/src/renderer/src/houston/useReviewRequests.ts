import { useCallback, useEffect, useState } from 'react'
import type { HoustonClient } from './client'
import type { ReviewRequest } from './generated/ReviewRequest'
import type { ReviewRequestMode } from './generated/ReviewRequestMode'
import type { DesktopNotificationMode } from '../usePreferences'
import { useReviewRequestNotice } from '../reviewRequestNotice'

export interface ReviewRequestsState {
  mode: ReviewRequestMode
  items: ReviewRequest[]
  /// A rate-limit pause; the queue keeps its rows and carries the note.
  pausedUntilMs: number | null
  note: string | null
}

/** The global review-request queue; one read gives the mode and every row, and
 *  the daemon broadcasts the same snapshot after a change. */
export function useReviewRequests(client: HoustonClient | null): {
  state: ReviewRequestsState | null
  setMode: (mode: ReviewRequestMode) => void
  dismiss: (id: number) => void
  reopen: (id: number) => void
} {
  const [state, setState] = useState<ReviewRequestsState | null>(null)

  useEffect(() => {
    setState(null)
    if (!client) return
    const off = client.subscribe('review_requests', (msg) => {
      setState({
        mode: msg.mode,
        items: msg.items,
        pausedUntilMs: msg.paused_until_ms ?? null,
        note: msg.note ?? null
      })
    })
    client.reviewRequestsGet()
    return off
  }, [client])

  const setMode = useCallback((mode: ReviewRequestMode) => client?.reviewRequestsSet(mode), [client])
  const dismiss = useCallback((id: number) => client?.reviewRequestDismiss(id), [client])
  const reopen = useCallback((id: number) => client?.reviewRequestReopen(id), [client])
  return { state, setMode, dismiss, reopen }
}

/** Rows that still need a decision; dismissed and already-reviewed ones do not
 *  count on the rail. The counter is hidden while the mode is off. */
export function newReviewRequestCount(state: ReviewRequestsState | null): number {
  if (!state || state.mode === 'off') return 0
  return state.items.filter((item) => item.state === 'new').length
}

/** One hook for the shell: the queue's new-request count and its desktop notice. */
export function useReviewRequestSummary(client: HoustonClient | null, desktopMode: DesktopNotificationMode): number {
  const { state } = useReviewRequests(client)
  useReviewRequestNotice(client, state?.mode ?? null, desktopMode)
  return newReviewRequestCount(state)
}
