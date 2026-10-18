// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient, MergeQueueAway } from '../../houston/client'
import { awayTitle, useMergeQueueAwayNotice } from './useMergeQueueAwayNotice'

type Handler = (message: unknown) => void

function fakeClient(): { client: HoustonClient; emit: (message: Record<string, unknown>) => void; acknowledged: string[] } {
  const handlers = new Map<string, Set<Handler>>()
  const acknowledged: string[] = []
  const client = {
    subscribe: (kind: string, handler: Handler) => {
      const set = handlers.get(kind) ?? new Set<Handler>()
      handlers.set(kind, set)
      set.add(handler)
      return () => set.delete(handler)
    },
    mergeQueueGet: vi.fn(),
    mergeQueueAcknowledge: (dir: string) => acknowledged.push(dir)
  } as unknown as HoustonClient
  const emit = (message: Record<string, unknown>): void => {
    for (const handler of handlers.get(message.type as string) ?? []) handler(message)
  }
  return { client, emit, acknowledged }
}

function snapshot(away: MergeQueueAway): Record<string, unknown> {
  return { type: 'merge_queue', workspace: '/repo', dir: null, entries: [], log: [], settings: null, global_paused: false, away, message: null }
}

afterEach(cleanup)

describe('the morning notice', () => {
  it('says what the queue merged and parked unattended', () => {
    expect(awayTitle({ merged: 5, parked: 1, last_merge_at_ms: 1 })).toBe('Merge queue merged 5 and parked 1 while you were away')
    expect(awayTitle({ merged: 0, parked: 2, last_merge_at_ms: null })).toBe('Merge queue parked 2 while you were away')
  })

  it('shows once when the user returns, and Review opens the queue and acknowledges', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { client, emit, acknowledged } = fakeClient()
    const push = vi.fn(() => 'merge-queue-away')
    const dismiss = vi.fn()
    const openQueue = vi.fn()
    renderHook(() => useMergeQueueAwayNotice(client, '/repo', push, dismiss, openQueue))
    const at = new Date(2026, 9, 18, 6, 40).getTime()
    act(() => emit(snapshot({ merged: 5, parked: 1, last_merge_at_ms: at })))
    expect(push).toHaveBeenCalledTimes(1)
    const notice = (push.mock.calls[0] as unknown as [{ title: string; body: string; action: { onClick: () => void } }])[0]
    expect(notice.title).toBe('Merge queue merged 5 and parked 1 while you were away')
    expect(notice.body).toBe('Last merge 06:40.')

    // A merge while the user is looking is not news from while they were away.
    act(() => emit(snapshot({ merged: 6, parked: 1, last_merge_at_ms: at + 1 })))
    expect(push).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(push).toHaveBeenCalledTimes(2)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(push).toHaveBeenCalledTimes(2)

    act(() => notice.action.onClick())
    expect(acknowledged).toEqual(['/repo'])
    expect(openQueue).toHaveBeenCalled()
    act(() => emit(snapshot({ merged: 0, parked: 0, last_merge_at_ms: null })))
    expect(dismiss).toHaveBeenCalledWith('merge-queue-away')
  })
})
