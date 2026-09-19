export interface PendingGitOps {
  review: boolean
  commit: boolean
  push: boolean
  status: boolean
}

export interface GitErrorResolution {
  clearReview: boolean
  clearCommit: boolean
  cancelPushAfterCommit: boolean
  clearPush: boolean
  clearStatus: boolean
  reviewError: string | null
  commitError: string | null
  statusError: string | null
}

const NONE: GitErrorResolution = {
  clearReview: false,
  clearCommit: false,
  cancelPushAfterCommit: false,
  clearPush: false,
  clearStatus: false,
  reviewError: null,
  commitError: null,
  statusError: null
}

// Priority order review > commit > push > status. A commit/push error also
// silently clears a stale pendingStatus but never shows a status error for
// it, so a second message doesn't bury the failure already on screen.
export function resolveGitError(pending: PendingGitOps, message: string): GitErrorResolution {
  if (pending.review) {
    return {
      ...NONE,
      clearReview: true,
      reviewError: message,
      clearCommit: pending.commit,
      commitError: pending.commit ? message : null,
      clearStatus: pending.status,
      statusError: pending.status ? message : null
    }
  }
  if (pending.commit) {
    return {
      ...NONE,
      clearCommit: true,
      cancelPushAfterCommit: true,
      commitError: message,
      clearStatus: true
    }
  }
  if (pending.push) {
    return { ...NONE, clearPush: true, commitError: message, clearStatus: true }
  }
  if (pending.status) {
    return { ...NONE, clearStatus: true, statusError: message }
  }
  return NONE
}
