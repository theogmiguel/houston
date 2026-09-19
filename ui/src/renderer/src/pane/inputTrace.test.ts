// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { codePoints, INPUT_TRACE_KEY, inputTraceEnabled } from './inputTrace'

describe('codePoints (B3-10 follow-up)', () => {
  it('distinguishes the two encodings of ç, which look identical when printed', () => {
    expect(codePoints('ç')).toBe('U+00E7')
    expect(codePoints('ç')).toBe('U+0063 U+0327')
    expect('ç'.normalize('NFC')).toBe('ç'.normalize('NFC'))
  })

  it('renders the accents from the test protocol', () => {
    expect(codePoints('á')).toBe('U+00E1')
    expect(codePoints('ã')).toBe('U+00E3')
  })

  it('splits by code point, not UTF-16 unit', () => {
    expect(codePoints('😀')).toBe('U+1F600')
  })

  it('handles an empty payload without inventing one', () => {
    expect(codePoints('')).toBe('')
  })
})

describe('inputTraceEnabled (B3-10 follow-up)', () => {
  it('is off unless explicitly switched on', () => {
    localStorage.removeItem(INPUT_TRACE_KEY)
    expect(inputTraceEnabled()).toBe(false)
    localStorage.setItem(INPUT_TRACE_KEY, '0')
    expect(inputTraceEnabled()).toBe(false)
    localStorage.setItem(INPUT_TRACE_KEY, '1')
    expect(inputTraceEnabled()).toBe(true)
    localStorage.removeItem(INPUT_TRACE_KEY)
  })
})
