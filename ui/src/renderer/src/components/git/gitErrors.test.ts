import { describe, expect, it } from 'vitest'
import { resolveGitError, type PendingGitOps } from './gitErrors'

const NONE_PENDING: PendingGitOps = { review: false, commit: false, push: false, status: false }

describe('resolveGitError', () => {
  it('attributes to review first when a review is pending, alone', () => {
    const r = resolveGitError({ ...NONE_PENDING, review: true }, 'boom')
    expect(r.clearReview).toBe(true)
    expect(r.reviewError).toBe('boom')
    expect(r.clearCommit).toBe(false)
    expect(r.clearPush).toBe(false)
    expect(r.clearStatus).toBe(false)
    expect(r.commitError).toBeNull()
    expect(r.statusError).toBeNull()
    expect(r.cancelPushAfterCommit).toBe(false)
  })

  it('review outranks a simultaneously-pending commit, and sweeps it up with the same message', () => {
    const r = resolveGitError({ ...NONE_PENDING, review: true, commit: true }, 'boom')
    expect(r.clearReview).toBe(true)
    expect(r.reviewError).toBe('boom')
    expect(r.clearCommit).toBe(true)
    expect(r.commitError).toBe('boom')
    expect(r.cancelPushAfterCommit).toBe(false)
  })

  it('review outranks a simultaneously-pending status, and sweeps it up with the same message', () => {
    const r = resolveGitError({ ...NONE_PENDING, review: true, status: true }, 'boom')
    expect(r.clearReview).toBe(true)
    expect(r.clearStatus).toBe(true)
    expect(r.statusError).toBe('boom')
  })

  it('review never sweeps up a simultaneously-pending push', () => {
    const r = resolveGitError({ ...NONE_PENDING, review: true, push: true }, 'boom')
    expect(r.clearReview).toBe(true)
    expect(r.clearPush).toBe(false)
  })

  it('attributes to commit when no review is pending, and cancels commit-then-push', () => {
    const r = resolveGitError({ ...NONE_PENDING, commit: true }, 'commit failed')
    expect(r.clearCommit).toBe(true)
    expect(r.commitError).toBe('commit failed')
    expect(r.cancelPushAfterCommit).toBe(true)
    expect(r.clearStatus).toBe(true)
    expect(r.statusError).toBeNull()
    expect(r.clearReview).toBe(false)
    expect(r.clearPush).toBe(false)
  })

  it('attributes to push when no review or commit is pending, reported on the commit line', () => {
    const r = resolveGitError({ ...NONE_PENDING, push: true }, 'push failed')
    expect(r.clearPush).toBe(true)
    expect(r.commitError).toBe('push failed')
    expect(r.clearStatus).toBe(true)
    expect(r.statusError).toBeNull()
    expect(r.clearReview).toBe(false)
    expect(r.clearCommit).toBe(false)
    expect(r.cancelPushAfterCommit).toBe(false)
  })

  it('attributes to status only when nothing else is pending', () => {
    const r = resolveGitError({ ...NONE_PENDING, status: true }, 'status failed')
    expect(r.clearStatus).toBe(true)
    expect(r.statusError).toBe('status failed')
    expect(r.clearReview).toBe(false)
    expect(r.clearCommit).toBe(false)
    expect(r.clearPush).toBe(false)
  })

  it('claims nothing when no operation is pending', () => {
    const r = resolveGitError(NONE_PENDING, 'orphaned error')
    expect(r).toEqual({
      clearReview: false,
      clearCommit: false,
      cancelPushAfterCommit: false,
      clearPush: false,
      clearStatus: false,
      reviewError: null,
      commitError: null,
      statusError: null
    })
  })

  it('commit outranks push when, somehow, both are pending', () => {
    const r = resolveGitError({ ...NONE_PENDING, commit: true, push: true }, 'boom')
    expect(r.clearCommit).toBe(true)
    expect(r.clearPush).toBe(false)
  })
})
