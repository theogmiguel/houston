import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../houston/client'
import type { PaneRoster } from './DelegationCard'
import {
  endedLabel,
  isGridSession,
  recentAfterSelection,
  rosterChildren,
  rosterSessions,
  visiblePeek,
  withSessionFamily
} from './sessionPaneSubscriptions'

const session = (id: number): SessionInfo => ({ id } as SessionInfo)

describe('SessionPane session subscriptions', () => {
  it('maps settled states to their existing labels', () => {
    expect(endedLabel('exited')).toBe('DONE')
    expect(endedLabel('killed')).toBe('KILLED')
    expect(endedLabel('interrupted')).toBe('INTERRUPTED')
    expect(endedLabel('running')).toBeNull()
  })

  it('uses the roster session map as the family fallback when available', () => {
    const sessions = new Map([[1, session(1)]])
    const roster: PaneRoster = { sessions, maxLiveChildren: 8 }

    expect(rosterSessions(roster)).toBe(sessions)
    expect(rosterSessions(undefined)).toBeUndefined()
  })

  it('replaces sessions on an existing roster and leaves an absent roster absent', () => {
    const initialSessions = new Map([[1, session(1)]])
    const family = new Map([[1, session(1)], [2, session(2)]])
    const roster: PaneRoster = { sessions: initialSessions, maxLiveChildren: 8 }
    const result = withSessionFamily(roster, family)

    expect(result).toEqual({ sessions: family, maxLiveChildren: 8 })
    expect(result).not.toBe(roster)
    expect(withSessionFamily(undefined, family)).toBeUndefined()
  })

  it('returns spawned children sorted by session id', () => {
    const children = new Map([
      [3, { ...session(3), spawned_by: 1 }],
      [2, { ...session(2), spawned_by: 1 }],
      [4, { ...session(4), spawned_by: 9 }]
    ])

    expect(rosterChildren(children, 1).map(({ id }) => id)).toEqual([2, 3])
    expect(rosterChildren(undefined, 1)).toEqual([])
  })

  it('hides a selected child already in the grid', () => {
    const children = [session(2)]

    expect(visiblePeek(children, 2, new Set())).toBe(children[0])
    expect(visiblePeek(children, 2, new Set([2]))).toBeUndefined()
    expect(visiblePeek(children, null, undefined)).toBeUndefined()
  })

  it('recognizes only grid members and refreshes recent selections without duplicates', () => {
    expect(isGridSession(2, new Set([2]))).toBe(true)
    expect(isGridSession(2, undefined)).toBe(false)
    expect(isGridSession(null, new Set([2]))).toBe(false)
    expect(recentAfterSelection([3, 2, 1], 2, 3)).toEqual([2, 3, 1])
    expect(recentAfterSelection([3, 2, 1], 4, 2)).toEqual([4, 3])
  })
})
