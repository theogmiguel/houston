// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import { useGitErrorRouter } from './useGitErrorRouter'

type ErrorHandler = (message: { message: string; context?: string | null }) => void

function mount(pendingStatus: string | null) {
  let handler: ErrorHandler = () => {}
  const client = {
    subscribe: (_type: string, next: ErrorHandler) => {
      handler = next
      return () => {}
    },
  } as unknown as HoustonClient
  const setStatusError = vi.fn()
  const status = { current: pendingStatus }
  const idle = <T,>(value: T) => ({ current: value })
  renderHook(() =>
    useGitErrorRouter({
      client,
      repoDir: '/repo',
      base: null,
      pendingStatus: status,
      pendingCommit: idle<string | null>(null),
      pendingPush: idle<string | null>(null),
      pendingReview: idle(null),
      pendingTools: idle<string | null>(null),
      pushAfterCommitRef: idle(false),
      setReviewBusy: vi.fn(),
      setReviewError: vi.fn(),
      setCommitting: vi.fn(),
      setCommitError: vi.fn(),
      setPushAfterCommit: vi.fn(),
      setPushing: vi.fn(),
      setStatusError,
      setToolsBusy: vi.fn(),
      setToolsError: vi.fn(),
    }),
  )
  return { emit: (message: string, context?: string) => handler({ message, context }), setStatusError, status }
}

describe('useGitErrorRouter', () => {
  afterEach(cleanup)

  test('a refused git_branch request is not the failure of a pending status refresh', () => {
    const { emit, setStatusError, status } = mount('/repo')
    emit('control handler limits: refused control request git_branch', 'control_admission:git_branch:/repo')
    expect(setStatusError).not.toHaveBeenCalled()
    expect(status.current).toBe('/repo')
  })

  test('another error still fails a pending status refresh', () => {
    const { emit, setStatusError, status } = mount('/repo')
    emit('git target is not a directory', 'git_status')
    expect(setStatusError).toHaveBeenCalledWith('git target is not a directory')
    expect(status.current).toBeNull()
  })
})
