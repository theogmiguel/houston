// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  loadNotifyKinds,
  notifyAllowed,
  NOTIFY_KIND_ROWS,
  NOTIFY_KINDS_DEFAULT,
  NOTIFY_KINDS_KEY,
  saveNotifyKinds
} from './notifyPrefs'

describe('per-alert-type notifications (row 23)', () => {
  it('defaults to everything on', () => {
    localStorage.removeItem(NOTIFY_KINDS_KEY)
    expect(loadNotifyKinds()).toEqual(NOTIFY_KINDS_DEFAULT)
    expect(Object.values(NOTIFY_KINDS_DEFAULT).every(Boolean)).toBe(true)
  })

  it('narrows without ever enabling past the master switch', () => {
    const all = { ...NOTIFY_KINDS_DEFAULT }
    expect(notifyAllowed(true, all, 'needs-input')).toBe(true)
    expect(notifyAllowed(false, all, 'needs-input')).toBe(false)
    expect(notifyAllowed(true, { ...all, completed: false }, 'completed')).toBe(false)
    expect(notifyAllowed(true, { ...all, completed: false }, 'error')).toBe(true)
  })

  it('treats a kind missing from stored prefs as on', () => {
    localStorage.setItem(NOTIFY_KINDS_KEY, JSON.stringify({ completed: false }))
    const loaded = loadNotifyKinds()
    expect(loaded.completed).toBe(false)
    expect(loaded.error).toBe(true)
    expect(loaded['needs-input']).toBe(true)
    localStorage.removeItem(NOTIFY_KINDS_KEY)
  })

  it('falls back to all-on for a corrupt blob rather than to silence', () => {
    localStorage.setItem(NOTIFY_KINDS_KEY, '{not json')
    expect(loadNotifyKinds()).toEqual(NOTIFY_KINDS_DEFAULT)
    localStorage.setItem(NOTIFY_KINDS_KEY, '"a string"')
    expect(loadNotifyKinds()).toEqual(NOTIFY_KINDS_DEFAULT)
    localStorage.removeItem(NOTIFY_KINDS_KEY)
  })

  it('round-trips through storage', () => {
    const kinds = { ...NOTIFY_KINDS_DEFAULT, info: false }
    saveNotifyKinds(kinds)
    expect(loadNotifyKinds()).toEqual(kinds)
    localStorage.removeItem(NOTIFY_KINDS_KEY)
  })

  it('offers a row for every kind it can silence', () => {
    const rowKinds = NOTIFY_KIND_ROWS.map((r) => r.kind).sort()
    expect(rowKinds).toEqual(Object.keys(NOTIFY_KINDS_DEFAULT).sort())
  })
})
