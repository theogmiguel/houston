// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg, HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import { FACTORY_REFRESH_MS, useFactorySettings } from './useFactorySettings'

function fakeClient(): { client: Pick<HoustonClient, 'subscribe' | 'send'>; gets: () => number; emit: (message: ServerMsg) => void } {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const sent: ClientMsg[] = []
  const client = {
    subscribe: (type: string, handler: (message: ServerMsg) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => handlers.get(type)?.delete(handler)
    },
    send: (message: ClientMsg) => sent.push(message)
  } as unknown as Pick<HoustonClient, 'subscribe' | 'send'>
  return {
    client,
    gets: () => sent.filter((message) => message.type === 'factory_settings_get').length,
    emit: (message) => act(() => handlers.get(message.type)?.forEach((handler) => handler(message)))
  }
}

const SETTINGS: ServerMsg = { type: 'factory_settings', live_runs_max: 3, needs_you_max: 3, live_runs: 1, needs_you: 0 }
const RUN_CHANGED = { type: 'task_run_changed', run: { id: 1, task_id: 1 } } as unknown as ServerMsg

describe('useFactorySettings', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('re-reads the counts once per burst of task events', () => {
    const { client, gets, emit } = fakeClient()
    const { result } = renderHook(() => useFactorySettings(client))
    expect(gets()).toBe(1)
    emit(SETTINGS)
    expect(result.current.settings).toEqual({ liveRunsMax: 3, needsYouMax: 3, liveRuns: 1, needsYou: 0 })

    emit({ type: 'task_changed', workspace: '/w', id: 1, revision: 2 })
    emit(RUN_CHANGED)
    emit({ type: 'task_snapshot', scope: 'all', tasks: [], counts: { ready: 0, backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 } })
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS - 1))
    expect(gets()).toBe(1)
    act(() => vi.advanceTimersByTime(1))
    expect(gets()).toBe(2)

    emit({ ...SETTINGS, live_runs: 2 } as ServerMsg)
    expect(result.current.settings?.liveRuns).toBe(2)
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS * 4))
    expect(gets()).toBe(2)
  })

  it('keeps one request in flight and re-reads after it answers when events arrived meanwhile', () => {
    const { client, gets, emit } = fakeClient()
    renderHook(() => useFactorySettings(client))
    emit(SETTINGS)
    emit(RUN_CHANGED)
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS))
    expect(gets()).toBe(2)

    emit(RUN_CHANGED)
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS))
    expect(gets()).toBe(2)

    emit(SETTINGS)
    expect(gets()).toBe(2)
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS))
    expect(gets()).toBe(3)
  })

  it('stops refreshing when unmounted', () => {
    const { client, gets, emit } = fakeClient()
    const { unmount } = renderHook(() => useFactorySettings(client))
    emit(SETTINGS)
    emit(RUN_CHANGED)
    unmount()
    act(() => vi.advanceTimersByTime(FACTORY_REFRESH_MS))
    expect(gets()).toBe(1)
  })
})
