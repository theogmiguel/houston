// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './houston/client'
import type { ServerMsg } from './houston/generated/ServerMsg'
import { isFocused, notifyNative } from './houston/bridge'
import { reviewRequestNoticeText, reviewRequestShouldNotify, useReviewRequestNotice } from './reviewRequestNotice'

vi.mock('./houston/bridge', () => ({
  isFocused: vi.fn().mockResolvedValue(false),
  notifyNative: vi.fn().mockResolvedValue(undefined)
}))

const notice: Extract<ServerMsg, { type: 'review_request_notice' }> = {
  type: 'review_request_notice',
  id: 9,
  repo: 'acme/houston',
  number: 42,
  title: 'A pane keeps its name',
  tier: 'b'
}

function fakeClient() {
  const handlers = new Map<string, (msg: ServerMsg) => void>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      handlers.set(kind, handler)
      return () => handlers.delete(kind)
    }
  } as unknown as HoustonClient
  const emit = (msg: ServerMsg): void => {
    act(() => handlers.get(msg.type)?.(msg))
  }
  return { client, emit }
}

describe('review request notice', () => {
  beforeEach(() => {
    vi.mocked(isFocused).mockResolvedValue(false)
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('describes the request without a bare score', () => {
    expect(reviewRequestNoticeText(notice)).toEqual({
      title: 'Review requested',
      body: 'acme/houston#42 · A pane keeps its name · Tier B'
    })
  })

  it('notifies only when the queue is on and desktop notifications are enabled', () => {
    expect(reviewRequestShouldNotify('off', 'notifications')).toBe(false)
    expect(reviewRequestShouldNotify('notify', 'off')).toBe(false)
    expect(reviewRequestShouldNotify('notify', 'sound')).toBe(false)
    expect(reviewRequestShouldNotify('notify', 'notifications')).toBe(true)
    expect(reviewRequestShouldNotify('review', 'notifications-sound')).toBe(true)
  })

  it('sends one desktop notification for a new request while unfocused', async () => {
    const { client, emit } = fakeClient()
    renderHook(() => useReviewRequestNotice(client, 'notify', 'notifications'))
    emit(notice)
    await waitFor(() => expect(notifyNative).toHaveBeenCalledWith('Review requested', 'acme/houston#42 · A pane keeps its name · Tier B', 0))
  })

  it('stays silent when the queue is off, the window is focused, or notifications are off', async () => {
    const off = fakeClient()
    renderHook(() => useReviewRequestNotice(off.client, 'off', 'notifications'))
    off.emit(notice)
    await Promise.resolve()
    expect(notifyNative).not.toHaveBeenCalled()

    const focused = fakeClient()
    vi.mocked(isFocused).mockResolvedValue(true)
    renderHook(() => useReviewRequestNotice(focused.client, 'notify', 'notifications'))
    focused.emit(notice)
    await Promise.resolve()
    expect(notifyNative).not.toHaveBeenCalled()

    const desktopOff = fakeClient()
    renderHook(() => useReviewRequestNotice(desktopOff.client, 'review', 'off'))
    desktopOff.emit(notice)
    await Promise.resolve()
    expect(notifyNative).not.toHaveBeenCalled()
  })
})
