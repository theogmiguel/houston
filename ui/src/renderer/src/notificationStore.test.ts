import { beforeEach, describe, expect, it } from 'vitest'
import {
  addNotification,
  getDedupeKeyCountForTests,
  getNotifications,
  resetNotificationStoreForTests
} from './notificationStore'

beforeEach(() => {
  resetNotificationStoreForTests()
})

describe('addNotification', () => {
  it('dedupes the same key + body within the 5000ms cooldown', () => {
    const first = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    expect(first).not.toBeNull()

    const second = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000 + 4_999
    )
    expect(second).toBeNull()
  })

  it('fires again for the same key with a different body', () => {
    const first = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    expect(first).not.toBeNull()

    const second = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'needs your input' },
      1_000 + 10
    )
    expect(second).not.toBeNull()
  })

  it('fires again for the same key + body after the cooldown elapses', () => {
    const first = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    expect(first).not.toBeNull()

    const second = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000 + 5_000
    )
    expect(second).not.toBeNull()
  })

  it('keys on session/agentId + kind — a different session is never deduped against another', () => {
    const a = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    const b = addNotification(
      { session: 2, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  it('falls back to agentId when there is no session', () => {
    const a = addNotification({ agentId: 'swarm-7', kind: 'swarm-message', title: 't', dir: '', text: 'x' }, 1_000)
    const b = addNotification(
      { agentId: 'swarm-7', kind: 'swarm-message', title: 't', dir: '', text: 'x' },
      1_000 + 1
    )
    expect(a).not.toBeNull()
    expect(b).toBeNull()
  })

  it('records read:false by default', () => {
    const rec = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished' },
      1_000
    )
    expect(rec?.read).toBe(false)
  })

  it('records read:true when the input carries it', () => {
    const rec = addNotification(
      { session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'finished', read: true },
      1_000
    )
    expect(rec?.read).toBe(true)
  })

  it('sweeps dedupe-map entries once they age past the cooldown', () => {
    addNotification({ session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'a' }, 0)
    expect(getDedupeKeyCountForTests()).toBe(1)

    addNotification({ session: 2, kind: 'agent-notice', title: 't', dir: '/d', text: 'b' }, 6_000)
    expect(getDedupeKeyCountForTests()).toBe(1)
  })

  it('does not sweep a key still inside the cooldown window', () => {
    addNotification({ session: 1, kind: 'agent-notice', title: 't', dir: '/d', text: 'a' }, 0)
    addNotification({ session: 2, kind: 'agent-notice', title: 't', dir: '/d', text: 'b' }, 4_999)
    expect(getDedupeKeyCountForTests()).toBe(2)
  })

  it('caps the retained list at 200 entries', () => {
    for (let i = 0; i < 250; i++) {
      addNotification(
        { session: i, kind: 'agent-notice', title: 't', dir: '/d', text: `msg-${i}` },
        1_000 + i
      )
    }
    expect(getNotifications()).toHaveLength(200)
    expect(getNotifications()[0].text).toBe('msg-249')
    expect(getNotifications().some((n) => n.text === 'msg-0')).toBe(false)
  })
})
