import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { AgentKind, HoustonClient } from '../../houston/client'
import { buildStructuredReviewPrompt, structuredReviewPrompt, type ReviewDiffsData } from '../../git/review'
import { saveReview } from '../../houston/bridge'

export interface ReviewNotice {
  truncated: boolean
  redacted: boolean
  blockedPaths: string[]
}

export interface ReviewRequest {
  dir: string
  agent: AgentKind
}

export interface ReviewSubscriptionParams {
  client: HoustonClient | null
  repoDir: string | null
  base: string | null
  pendingReview: RefObject<ReviewRequest | null>
  onReviewPacketRef: RefObject<((data: ReviewDiffsData) => void) | undefined>
  setReviewBusy: Dispatch<SetStateAction<boolean>>
  setReviewError: Dispatch<SetStateAction<string | null>>
  setReviewNotice: Dispatch<SetStateAction<ReviewNotice | null>>
}

export function useReviewSubscription({
  client,
  repoDir,
  base,
  pendingReview,
  onReviewPacketRef,
  setReviewBusy,
  setReviewError,
  setReviewNotice
}: ReviewSubscriptionParams): void {
  // Kept on the same `[client, repoDir, base]` cadence the single ChangesPane
  // effect had: narrowing to `client` would let an in-flight review survive a
  // base switch it never used to, a behaviour change this extraction avoids.
  useEffect(() => {
    if (!client || !repoDir) return
    const unsubReview = client.subscribe('git_review_diffs', (msg) => {
      const request = pendingReview.current
      if (request === null || msg.dir !== request.dir) return
      pendingReview.current = null
      const targetDir = msg.dir
      if (msg.sections.length === 0) {
        setReviewBusy(false)
        setReviewError('No safe diff content is available for review.')
        return
      }
      setReviewNotice({
        truncated: msg.truncated,
        redacted: msg.redacted,
        blockedPaths: msg.blocked_paths
      })
      const prompt = buildStructuredReviewPrompt(msg)
      void saveReview(prompt)
        .then((file) => {
          onReviewPacketRef.current?.(msg)
          client.createSession({
            agent: request.agent,
            project_dir: targetDir,
            prompt: structuredReviewPrompt(file)
          })
        })
        .catch((e: Error) => setReviewError(`saving review failed: ${e.message}`))
        .finally(() => setReviewBusy(false))
    })
    return () => {
      unsubReview()
      pendingReview.current = null
      setReviewBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs/setters are stable identities; deps mirror the original effect's own [client, repoDir, base], see the doc comment above.
  }, [client, repoDir, base])
}
