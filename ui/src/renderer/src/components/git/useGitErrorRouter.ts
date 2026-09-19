import { useEffect, type RefObject } from 'react'
import type { HoustonClient } from '../../houston/client'
import { resolveGitError } from './gitErrors'
import type { ReviewRequest } from './useReviewSubscription'

export interface GitErrorRouterParams {
  client: HoustonClient | null
  repoDir: string | null
  base: string | null
  pendingStatus: RefObject<string | null>
  pendingCommit: RefObject<string | null>
  pendingPush: RefObject<string | null>
  pendingReview: RefObject<ReviewRequest | null>
  pendingTools: RefObject<string | null>
  pendingCompose: RefObject<string | null>
  pushAfterCommitRef: RefObject<boolean>
  setReviewBusy: (busy: boolean) => void
  setReviewError: (message: string | null) => void
  setCommitting: (busy: boolean) => void
  setCommitError: (message: string | null) => void
  setPushAfterCommit: (on: boolean) => void
  setPushing: (busy: boolean) => void
  setStatusError: (message: string | null) => void
  setToolsBusy: (busy: boolean) => void
  setToolsError: (message: string | null) => void
  claimComposeError: (message: string) => void
}

// One connection-wide error stream, claimed by whichever operation is in
// flight. Tools and the PR compose own their pending refs so the pane's render
// carries none of this routing.
export function useGitErrorRouter({
  client,
  repoDir,
  base,
  pendingStatus,
  pendingCommit,
  pendingPush,
  pendingReview,
  pendingTools,
  pendingCompose,
  pushAfterCommitRef,
  setReviewBusy,
  setReviewError,
  setCommitting,
  setCommitError,
  setPushAfterCommit,
  setPushing,
  setStatusError,
  setToolsBusy,
  setToolsError,
  claimComposeError
}: GitErrorRouterParams): void {
  useEffect(() => {
    if (!client || !repoDir) return
    const unsubError = client.subscribe('error', (msg) => {
      if (pendingTools.current !== null) {
        pendingTools.current = null
        setToolsBusy(false)
        setToolsError(msg.message)
        return
      }
      if (pendingCompose.current !== null) {
        claimComposeError(msg.message)
        return
      }
      const resolution = resolveGitError(
        {
          review: pendingReview.current !== null,
          commit: pendingCommit.current !== null,
          push: pendingPush.current !== null,
          status: pendingStatus.current !== null
        },
        msg.message
      )
      if (resolution.clearReview) {
        pendingReview.current = null
        setReviewBusy(false)
        setReviewError(resolution.reviewError)
      }
      if (resolution.clearCommit) {
        pendingCommit.current = null
        setCommitting(false)
        setCommitError(resolution.commitError)
      }
      if (resolution.cancelPushAfterCommit) {
        setPushAfterCommit(false)
        pushAfterCommitRef.current = false
      }
      if (resolution.clearPush) {
        pendingPush.current = null
        setPushing(false)
        setCommitError(resolution.commitError)
      }
      if (resolution.clearStatus) {
        pendingStatus.current = null
        if (resolution.statusError !== null) setStatusError(resolution.statusError)
      }
    })
    return () => {
      unsubError()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs and setters are stable identities
  }, [client, repoDir, base])
}
