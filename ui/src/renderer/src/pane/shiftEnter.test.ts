// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  BRACKETED_NEWLINE,
  SHIFT_ENTER_KEY,
  shiftEnterEnabled,
  shiftEnterSequence
} from './shiftEnter'

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>

function key(over: Partial<Key> = {}): Key {
  return { key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over }
}

describe('shiftEnterSequence (row 10)', () => {
  it('sends a bracketed-paste newline for Shift+Enter', () => {
    expect(shiftEnterSequence(key({ shiftKey: true }), true)).toBe(BRACKETED_NEWLINE)
  })

  it('wraps the newline in the paste markers, and uses CR inside them', () => {
    expect(BRACKETED_NEWLINE).toBe('\x1b[200~\r\x1b[201~')
  })

  it('leaves a plain Enter alone, which must still submit', () => {
    expect(shiftEnterSequence(key(), true)).toBeNull()
  })

  it('leaves Ctrl/Alt/Meta+Enter to the application that bound them', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(shiftEnterSequence(key({ shiftKey: true, [mod]: true }), true)).toBeNull()
    }
  })

  it('ignores every other key', () => {
    for (const k of ['a', 'Tab', 'Escape', 'ArrowDown', 'NumpadEnter']) {
      expect(shiftEnterSequence(key({ key: k, shiftKey: true }), true)).toBeNull()
    }
  })

  it('does nothing at all when the setting is off', () => {
    expect(shiftEnterSequence(key({ shiftKey: true }), false)).toBeNull()
  })
})

describe('shiftEnterEnabled (row 10)', () => {
  it('defaults ON when nothing is stored, matching the donor', () => {
    localStorage.removeItem(SHIFT_ENTER_KEY)
    expect(shiftEnterEnabled()).toBe(true)
  })

  it('is off only for an explicit 0', () => {
    localStorage.setItem(SHIFT_ENTER_KEY, '0')
    expect(shiftEnterEnabled()).toBe(false)
    localStorage.setItem(SHIFT_ENTER_KEY, '1')
    expect(shiftEnterEnabled()).toBe(true)
    localStorage.setItem(SHIFT_ENTER_KEY, 'nonsense')
    expect(shiftEnterEnabled()).toBe(true)
    localStorage.removeItem(SHIFT_ENTER_KEY)
  })
})
