// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import { GIT_STATUS_IN_FLIGHT_LIMIT, GIT_STATUS_REPLY_TIMEOUT_MS } from './gitStatusPoller'
import { FOCUS_REFRESH_MIN_MS, useRailGitFacts } from './useRailGitFacts'

type Handler = (message: never) => void

class FakeClient {
  readonly sent: string[] = []
  private readonly handlers = new Map<string, Set<Handler>>()
  private pending = new Set<string>()
  maxPending = 0
  duplicates = 0

  subscribe(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler)
    this.handlers.set(type, set)
    return () => set.delete(handler)
  }
  gitStatus(dir: string): void {
    if (this.pending.has(dir)) this.duplicates += 1
    this.sent.push(dir)
    this.pending.add(dir)
    this.maxPending = Math.max(this.maxPending, this.pending.size)
  }
  get inFlight(): string[] { return [...this.pending] }
  reply(dir: string, base: string | null = null): void {
    if (base === null) this.pending.delete(dir)
    this.emit('git_status', { type: 'git_status', dir, base, files: [], ahead: 0, behind: 0 })
  }
  fail(context: string): void {
    this.emit('error', { type: 'error', message: 'git target is not a directory', context })
  }
  private emit(type: string, message: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(message as never)
  }
}

const dirsOf = (count: number): string[] => Array.from({ length: count }, (_, i) => `/repo/wt-${i}`)

function mount(dirs: string[]): { client: FakeClient; rerender: (dirs: string[]) => void } {
  const client = new FakeClient()
  const hook = renderHook(({ list }) => useRailGitFacts(client as unknown as HoustonClient, list), { initialProps: { list: dirs } })
  return { client, rerender: (list) => hook.rerender({ list }) }
}

// Replies until nothing is pending, as a daemon would, recording the peak.
function drain(client: FakeClient): void {
  while (client.inFlight.length > 0) act(() => client.reply(client.inFlight[0]))
}

describe('useRailGitFacts request bound', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  test('a refresh over more than 16 directories never has more than the bound in flight', () => {
    const dirs = dirsOf(20)
    const { client } = mount(dirs)
    expect(client.inFlight).toHaveLength(GIT_STATUS_IN_FLIGHT_LIMIT)
    drain(client)
    expect(client.maxPending).toBeLessThanOrEqual(GIT_STATUS_IN_FLIGHT_LIMIT)
    expect([...client.sent].sort()).toEqual([...dirs].sort())
  })

  test('focus and interval refreshes do not duplicate directories in flight or queued', () => {
    const { client } = mount(dirsOf(20))
    // Replies keep arriving inside the timeout while focus and the 60 s interval fire between them.
    for (let round = 0; round < 45 && client.inFlight.length > 0; round += 1) {
      act(() => { vi.advanceTimersByTime(2_000); window.dispatchEvent(new Event('focus')) })
      act(() => client.reply(client.inFlight[0]))
    }
    expect(client.duplicates).toBe(0)
    expect(client.maxPending).toBeLessThanOrEqual(GIT_STATUS_IN_FLIGHT_LIMIT)
  })

  test('a directory is polled again once its previous request has replied', () => {
    const { client } = mount(dirsOf(2))
    drain(client)
    act(() => { vi.advanceTimersByTime(FOCUS_REFRESH_MIN_MS); window.dispatchEvent(new Event('focus')) })
    expect(client.sent).toEqual([...dirsOf(2), ...dirsOf(2)])
  })

  test('ten rapid focus events send one refresh, not ten', () => {
    const { client } = mount(dirsOf(2))
    drain(client)
    expect(client.sent).toHaveLength(2)
    // Alt-tab back ten times over five seconds, each round trip replying before the next.
    for (let i = 0; i < 10; i += 1) {
      act(() => { vi.advanceTimersByTime(500); window.dispatchEvent(new Event('focus')) })
      drain(client)
    }
    expect(client.sent).toHaveLength(2)
    // Past the throttle window the next focus refreshes again.
    act(() => { vi.advanceTimersByTime(FOCUS_REFRESH_MIN_MS); window.dispatchEvent(new Event('focus')) })
    drain(client)
    expect(client.sent).toHaveLength(4)
  })

  test('a changed directory set shares the bound with requests still pending', () => {
    const { client, rerender } = mount(dirsOf(4))
    rerender([...dirsOf(4), ...dirsOf(12).map((dir) => `${dir}-new`)])
    expect(client.sent).toEqual(dirsOf(4))
    drain(client)
    expect(client.maxPending).toBeLessThanOrEqual(GIT_STATUS_IN_FLIGHT_LIMIT)
    expect(client.sent).toHaveLength(16)
  })

  test('a diff-base reply does not free the slot of a working-tree request', () => {
    const { client } = mount(dirsOf(6))
    act(() => client.reply(dirsOf(6)[0], 'main'))
    expect(client.sent).toHaveLength(GIT_STATUS_IN_FLIGHT_LIMIT)
  })

  test('a git_status error frees a slot', () => {
    const { client } = mount(dirsOf(6))
    act(() => client.fail('git_status'))
    expect(client.sent).toHaveLength(GIT_STATUS_IN_FLIGHT_LIMIT + 1)
  })

  test('an error from another request does not free a slot', () => {
    const { client } = mount(dirsOf(6))
    act(() => client.fail('control_admission'))
    expect(client.sent).toHaveLength(GIT_STATUS_IN_FLIGHT_LIMIT)
  })

  test('a request that never replies frees its slot after the timeout', () => {
    const { client } = mount(dirsOf(6))
    act(() => { vi.advanceTimersByTime(GIT_STATUS_REPLY_TIMEOUT_MS) })
    expect(client.sent).toHaveLength(6)
  })
})

describe('useRailGitFacts failure backoff', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  test('a failing directory skips one tick, then two, four and eight, capped at fifteen minutes, until a reply resets the ladder', () => {
    const { client } = mount(dirsOf(1))
    const pollAfterFailure = (ticks: number): void => {
      act(() => client.fail('git_status'))
      const sent = client.sent.length
      act(() => { vi.advanceTimersByTime(ticks * 60_000) })
      expect(client.sent).toHaveLength(sent + 1)
    }
    pollAfterFailure(1)
    pollAfterFailure(2)
    pollAfterFailure(4)
    pollAfterFailure(8)
    // The next rung would be 16 minutes; the cap lets the 15-minute tick through.
    pollAfterFailure(15)
    act(() => client.fail('git_status'))
    const sent = client.sent.length
    act(() => { vi.advanceTimersByTime(14 * 60_000) })
    expect(client.sent).toHaveLength(sent)
    act(() => client.reply(dirsOf(1)[0]))
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(client.sent).toHaveLength(sent + 1)
  })

  test('a focus refresh is never delayed by the failure ladder', () => {
    const { client } = mount(dirsOf(1))
    drain(client)
    act(() => { vi.advanceTimersByTime(60_000) })
    act(() => client.fail('git_status'))
    const sent = client.sent.length
    act(() => {
      vi.advanceTimersByTime(FOCUS_REFRESH_MIN_MS)
      window.dispatchEvent(new Event('focus'))
    })
    expect(client.sent).toHaveLength(sent + 1)
  })
})
