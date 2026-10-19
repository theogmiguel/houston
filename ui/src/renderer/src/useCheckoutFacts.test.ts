// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Conn } from './App'
import type { HoustonClient, ServerMsg, SessionInfo } from './houston/client'
import {
  GIT_BRANCH_IN_FLIGHT_LIMIT,
  GIT_BRANCH_MAX_ATTEMPTS,
  GIT_BRANCH_REPLY_TIMEOUT_MS,
} from './checkoutBranchRequester'
import { useCheckoutFacts } from './useCheckoutFacts'

class FakeClient {
  readonly sent: string[] = []
  private readonly open = new Set<string>()
  peak = 0
  gitBranch(dir: string): void {
    this.sent.push(dir)
    this.open.add(dir)
    this.peak = Math.max(this.peak, this.open.size)
  }
  get inFlight(): string[] { return [...this.open] }
  answer(dir: string): ServerMsg {
    this.open.delete(dir)
    return { type: 'git_branch', dir, branch: `branch-of${dir}` } as unknown as ServerMsg
  }
  refuse(dir: string): ServerMsg {
    this.open.delete(dir)
    return {
      type: 'error',
      message: 'control handler limits: connection 16, process 64; active connection 16, process 16; refused control request git_branch',
      context: `control_admission:git_branch:${dir}`,
    }
  }
}

const session = (id: number, cwd: string): SessionInfo =>
  ({ id, agent: 'claude', cwd, project_dir: cwd, state: 'running', title: `pane-${id}`, hidden: false }) as unknown as SessionInfo

const PANES = 3 * GIT_BRANCH_IN_FLIGHT_LIMIT
const roster = Array.from({ length: PANES }, (_, i) => session(i + 1, `/repo/wt-${i}`))

function mount(sessions: SessionInfo[]) {
  const client = new FakeClient()
  const map = new Map(sessions.map((s) => [s.id, s]))
  const hook = renderHook(() =>
    useCheckoutFacts({
      conn: { kind: 'connecting' } as Conn,
      activeId: null,
      sessions: map,
      sessionsRef: { current: map },
      workspaces: [],
    }),
  )
  const asHouston = client as unknown as HoustonClient
  act(() => hook.result.current.reset(sessions))
  return { client, hook, asHouston }
}

describe('checkout branch requests under a burst', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  test('a roster of more panes than the cap never has more than the cap in flight', () => {
    const { client, hook, asHouston } = mount(roster)
    act(() => hook.result.current.requestForRoster(asHouston, roster))
    expect(client.sent).toHaveLength(GIT_BRANCH_IN_FLIGHT_LIMIT)
    while (client.inFlight.length > 0) {
      act(() => hook.result.current.handleMessage(client.answer(client.inFlight[0])))
    }
    expect(client.sent).toHaveLength(PANES)
    expect(client.peak).toBe(GIT_BRANCH_IN_FLIGHT_LIMIT)
    expect(hook.result.current.chips.size).toBe(PANES)
  })

  test('two panes in one directory share one request, and a spawn in a pending directory adds none', () => {
    const twins = [session(1, '/repo/a'), session(2, '/repo/a')]
    const { client, hook, asHouston } = mount(twins)
    act(() => hook.result.current.requestForRoster(asHouston, twins))
    act(() => hook.result.current.requestForSession(asHouston, session(3, '/repo/a')))
    expect(client.sent).toEqual(['/repo/a'])
  })

  test('every chip settles after the daemon refuses the burst', () => {
    const { client, hook, asHouston } = mount(roster)
    act(() => hook.result.current.requestForRoster(asHouston, roster))
    // The daemon refuses everything first sent, then has room.
    for (const dir of client.inFlight) act(() => hook.result.current.handleMessage(client.refuse(dir)))
    expect(client.inFlight.length).toBeLessThanOrEqual(GIT_BRANCH_IN_FLIGHT_LIMIT)
    for (let step = 0; step < 200 && hook.result.current.chips.size < PANES; step += 1) {
      act(() => { vi.advanceTimersByTime(500) })
      for (const dir of client.inFlight) act(() => hook.result.current.handleMessage(client.answer(dir)))
    }
    expect(client.peak).toBeLessThanOrEqual(GIT_BRANCH_IN_FLIGHT_LIMIT)
    expect(hook.result.current.chips.size).toBe(PANES)
  })

  test('a request that never replies is retried after the timeout', () => {
    const { client, hook, asHouston } = mount([session(1, '/repo/a')])
    act(() => hook.result.current.requestForRoster(asHouston, roster.slice(0, 1).map(() => session(1, '/repo/a'))))
    expect(client.sent).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(GIT_BRANCH_REPLY_TIMEOUT_MS + 10_000) })
    expect(client.sent).toHaveLength(2)
  })

  test('a directory that is refused every time stops pending, so a later ask goes out', () => {
    const only = [session(1, '/repo/a')]
    const { client, hook, asHouston } = mount(only)
    act(() => hook.result.current.requestForRoster(asHouston, only))
    for (let attempt = 0; attempt < GIT_BRANCH_MAX_ATTEMPTS; attempt += 1) {
      act(() => { vi.advanceTimersByTime(10_000) })
      for (const dir of client.inFlight) act(() => hook.result.current.handleMessage(client.refuse(dir)))
    }
    const sentBefore = client.sent.length
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(client.sent).toHaveLength(sentBefore)
    act(() => hook.result.current.requestForSession(asHouston, session(2, '/repo/a')))
    expect(client.sent).toHaveLength(sentBefore + 1)
  })

  test('a refusal of another request type leaves the branch ask in flight', () => {
    const only = [session(1, '/repo/a')]
    const { client, hook, asHouston } = mount(only)
    act(() => hook.result.current.requestForRoster(asHouston, only))
    act(() => hook.result.current.handleMessage({ type: 'error', message: 'refused', context: 'control_admission:pr_status:/repo/a' } as ServerMsg))
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(client.sent).toHaveLength(1)
  })
})
