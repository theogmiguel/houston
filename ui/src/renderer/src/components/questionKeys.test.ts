// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isDigitTarget, questionKeyAction } from './questionKeys'

const options = [{ id: 'a' }, { id: 'b' }]

describe('questionKeyAction', () => {
  it('maps 1..n to the option at that position', () => {
    expect(questionKeyAction('1', options)).toEqual({ kind: 'option', id: 'a' })
    expect(questionKeyAction('2', options)).toEqual({ kind: 'option', id: 'b' })
  })

  it('maps n + 1 to the type-instead row', () => {
    expect(questionKeyAction('3', options)).toEqual({ kind: 'type-instead' })
  })

  it('maps no key past the type-instead row, and no non-digit key', () => {
    expect(questionKeyAction('4', options)).toBeNull()
    expect(questionKeyAction('0', options)).toBeNull()
    expect(questionKeyAction('a', options)).toBeNull()
    expect(questionKeyAction('Enter', options)).toBeNull()
    expect(questionKeyAction('1.5', options)).toBeNull()
  })

  it('leaves options still loading with only the type-instead row', () => {
    expect(questionKeyAction('1', undefined)).toEqual({ kind: 'type-instead' })
    expect(questionKeyAction('2', undefined)).toBeNull()
  })
})

describe('isDigitTarget', () => {
  const press = (init: KeyboardEventInit, target?: HTMLElement): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true, ...init })
    if (target) {
      document.body.appendChild(target)
      target.dispatchEvent(e)
      target.remove()
    }
    return e
  }

  it('accepts a bare digit on the page', () => {
    expect(isDigitTarget(press({}, document.createElement('div')))).toBe(true)
  })

  it('refuses a digit typed into a field', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isDigitTarget(press({}, document.createElement(tag)))).toBe(false)
    }
  })

  it('refuses a digit with a modifier', () => {
    expect(isDigitTarget(press({ ctrlKey: true }, document.createElement('div')))).toBe(false)
    expect(isDigitTarget(press({ metaKey: true }, document.createElement('div')))).toBe(false)
    expect(isDigitTarget(press({ altKey: true }, document.createElement('div')))).toBe(false)
  })
})
