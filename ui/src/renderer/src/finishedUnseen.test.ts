import { describe, expect, it } from 'vitest'
import {
  finishedUnseenOnStatus,
  finishedUnseenWithout,
  pruneFinishedUnseen,
} from './finishedUnseen'
import type { SessionInfo } from './houston/client'

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 7,
    agent: 'claude',
    project_dir: '/repo',
    cwd: '/repo',
    state: 'running',
    title: 'Fix parser',
    codename: 'test',
    hidden: false,
    live_children: 0,
    children_waiting: 0,
    inbox_unread: 0,
    tags: [],
    resumable: false,
    spawned_by: null,
    status: 'working',
    ...overrides,
  } as SessionInfo
}

const NONE = new Set<number>()

describe('finishedUnseenOnStatus', () => {
  it('marks a top-level pane that finished off screen', () => {
    const previous = session({ status: 'working' })
    const next = finishedUnseenOnStatus(NONE, previous, 'idle', NONE)
    expect([...next]).toEqual([7])
  })

  it('does not mark a pane that was visible when it finished', () => {
    const previous = session({ status: 'working' })
    const next = finishedUnseenOnStatus(NONE, previous, 'idle', new Set([7]))
    expect(next.size).toBe(0)
  })

  it('does not mark delegated child panes', () => {
    const previous = session({ status: 'working', spawned_by: 3 })
    expect(finishedUnseenOnStatus(NONE, previous, 'idle', NONE).size).toBe(0)
  })

  it('does not mark a finish from any state other than working', () => {
    for (const status of ['idle', 'needs-input', 'spawning', 'unavailable'] as const) {
      expect(finishedUnseenOnStatus(NONE, session({ status }), 'idle', NONE).size).toBe(0)
    }
  })

  it('does not mark hidden panes or panes that left the roster', () => {
    expect(finishedUnseenOnStatus(NONE, session({ hidden: true, status: 'working' }), 'idle', NONE).size).toBe(0)
    expect(finishedUnseenOnStatus(NONE, session({ state: 'exited', status: 'working' }), 'idle', NONE).size).toBe(0)
    expect(finishedUnseenOnStatus(NONE, undefined, 'idle', NONE).size).toBe(0)
  })

  it('keeps an existing mark when the pane finishes again unseen', () => {
    const previous = session({ status: 'working' })
    const next = finishedUnseenOnStatus(new Set([7]), previous, 'idle', NONE)
    expect([...next]).toEqual([7])
  })

  it('clears the mark when a marked pane starts working again', () => {
    const previous = session({ status: 'idle' })
    const next = finishedUnseenOnStatus(new Set([7, 8]), previous, 'working', NONE)
    expect([...next]).toEqual([8])
  })

  it('leaves unrelated panes and statuses alone', () => {
    const previous = session({ id: 9, status: 'idle' })
    const state = new Set([7, 8])
    expect(finishedUnseenOnStatus(state, previous, 'needs-input', NONE)).toBe(state)
    expect(finishedUnseenOnStatus(state, previous, 'idle', new Set([9]))).toBe(state)
  })
})

describe('finishedUnseenWithout', () => {
  it('drops the mark on the focused pane', () => {
    expect([...finishedUnseenWithout(new Set([7, 8]), 7)]).toEqual([8])
  })

  it('is the same set when an unmarked pane is named', () => {
    const state = new Set([7])
    expect(finishedUnseenWithout(state, 8)).toBe(state)
  })
})

describe('pruneFinishedUnseen', () => {
  it('drops marks for panes no longer on the roster', () => {
    expect([...pruneFinishedUnseen(new Set([7, 8]), new Set([8]))]).toEqual([8])
  })

  it('is the same set when every mark is still known', () => {
    const state = new Set([7])
    expect(pruneFinishedUnseen(state, new Set([7, 8]))).toBe(state)
  })
})
