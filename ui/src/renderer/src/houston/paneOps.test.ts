import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE_SETTLE_TIMEOUT_MS,
  LIVE_CHILDREN_MARKER,
  PaneOps,
  RESPAWN_SETTLE_TIMEOUT_MS,
  errorSessionIds
} from './paneOps'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('errorSessionIds', () => {
  it('reads the session:<id> context first', () => {
    expect(errorSessionIds({ message: 'session 9 is busy', context: 'session:4' })).toEqual([4])
  })

  it('falls back to the ids the text names, for older daemons', () => {
    expect(errorSessionIds({ message: 'unknown session id 364 (expected an active session)', context: null })).toEqual([364])
    expect(errorSessionIds({ message: 'close refused: session 7 is closing' })).toEqual([7])
    expect(errorSessionIds({ message: 'refusing session_close for pane 1: 2 live children' })).toEqual([1])
  })

  it('does not read a session id out of another context or a longer number', () => {
    expect(errorSessionIds({ message: 'git failed', context: 'git_status' })).toEqual([])
    expect(errorSessionIds({ message: 'x', context: 'session:4x' })).toEqual([])
  })
})

describe('PaneOps', () => {
  it('tracks a session as closing from the request until the daemon removes it', () => {
    const ops = new PaneOps()
    const seen = vi.fn()
    ops.subscribe(seen)
    ops.beginClose(5)
    expect(ops.closingIds()).toEqual(new Set([5]))
    ops.sessionRemoved(5)
    expect(ops.closingIds().size).toBe(0)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('returns a stable snapshot until the closing set changes', () => {
    const ops = new PaneOps()
    ops.beginClose(5)
    const first = ops.closingIds()
    ops.beginRespawn(6)
    expect(ops.closingIds()).toBe(first)
  })

  it('a refusal releases the session and keeps the text for its pane', () => {
    const ops = new PaneOps()
    ops.beginClose(5)
    expect(ops.attribute({ message: 'close refused: session 5 is closing', context: 'session:5' })).toBe(5)
    expect(ops.closingIds().size).toBe(0)
    expect(ops.error(5)).toBe('close refused: session 5 is closing')
    ops.beginClose(5)
    expect(ops.error(5)).toBeNull()
  })

  it('ignores errors about sessions with nothing in flight', () => {
    const ops = new PaneOps()
    ops.beginClose(5)
    expect(ops.attribute({ message: 'session 6 failed', context: 'session:6' })).toBeNull()
    expect(ops.attribute({ message: 'ssh sessions open via ssh_connect', context: null })).toBeNull()
    expect(ops.closingIds()).toEqual(new Set([5]))
  })

  it('a live-children refusal releases the close but leaves the confirmation flow to the caller', () => {
    const ops = new PaneOps()
    ops.beginClose(1)
    expect(ops.attribute({ message: `${LIVE_CHILDREN_MARKER} session 1 still has 2 live spawned children`, context: null })).toBeNull()
    expect(ops.closingIds().size).toBe(0)
    expect(ops.error(1)).toBeNull()
  })

  it('hands the pane back with the limit named when a close is not confirmed in time', () => {
    const ops = new PaneOps()
    ops.beginClose(5)
    vi.advanceTimersByTime(CLOSE_SETTLE_TIMEOUT_MS - 1)
    expect(ops.closingIds()).toEqual(new Set([5]))
    vi.advanceTimersByTime(1)
    expect(ops.closingIds().size).toBe(0)
    expect(ops.error(5)).toBe(`Closing session 5 was not confirmed within ${CLOSE_SETTLE_TIMEOUT_MS} ms; the pane is back.`)
  })

  it('a respawn is in flight until the daemon answers, refuses, or the window passes', () => {
    const ops = new PaneOps()
    ops.beginRespawn(3)
    expect(ops.isRespawning(3)).toBe(true)
    ops.respawnSettled(3)
    expect(ops.isRespawning(3)).toBe(false)

    ops.beginRespawn(3)
    expect(ops.attribute({ message: 'respawn refused', context: 'session:3' })).toBe(3)
    expect(ops.isRespawning(3)).toBe(false)
    expect(ops.error(3)).toBe('respawn refused')

    ops.beginRespawn(3)
    vi.advanceTimersByTime(RESPAWN_SETTLE_TIMEOUT_MS)
    expect(ops.isRespawning(3)).toBe(false)
  })

  it('forgets a session and its error once it is removed', () => {
    const ops = new PaneOps()
    ops.beginRespawn(3)
    ops.attribute({ message: 'respawn refused', context: 'session:3' })
    ops.sessionRemoved(3)
    expect(ops.error(3)).toBeNull()
  })
})

describe('PaneOps errors for sessions already closing', () => {
  it('stdin refused because the session is closing keeps the close and stays out of the way', () => {
    const ops = new PaneOps()
    ops.beginClose(1)
    const error = { message: 'stdin refused: session 1 is closing', context: 'stdin' }

    expect(ops.attribute(error)).toBeNull()
    expect(ops.isStaleInput(error)).toBe(true)
    expect(ops.closingIds()).toEqual(new Set([1]))
    expect(ops.error(1)).toBeNull()
  })

  it('stdin refused for a session that is not closing is not stale', () => {
    const ops = new PaneOps()
    expect(ops.isStaleInput({ message: 'stdin refused: session 1 is closing', context: 'stdin' })).toBe(false)
  })

  it('a repeat of a refusal already shown in the pane is attributed, not a new notice', () => {
    const ops = new PaneOps()
    ops.beginClose(2)
    const text = 'session 2 is in a Sleep transition'
    expect(ops.attribute({ message: text, context: 'session:2' })).toBe(2)
    expect(ops.attribute({ message: text, context: 'session:2' })).toBe(2)
    expect(ops.error(2)).toBe(text)
  })
})
