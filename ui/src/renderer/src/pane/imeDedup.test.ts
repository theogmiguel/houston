import { describe, expect, it } from 'vitest'
import {
  decideImeDelivery,
  emptyImeDedupState,
  IME_DEDUP_WINDOW_MS,
  noteCompositionEnd,
  type ImeDedupState
} from './imeDedup'

function feed(
  state: ImeDedupState,
  payload: string,
  now: number
): { deliver: boolean; state: ImeDedupState } {
  return decideImeDelivery(state, payload, now)
}

describe('the doubled composition it exists to catch (B3-10)', () => {
  it('delivers the first arrival and drops the immediate duplicate', () => {
    let state = noteCompositionEnd('á', 1000)
    const first = feed(state, 'á', 1001)
    expect(first.deliver).toBe(true)

    const second = feed(first.state, 'á', 1002)
    expect(second.deliver).toBe(false)
  })

  it('delivers a THIRD arrival — two is what it can prove, not a licence', () => {
    let state = noteCompositionEnd('á', 1000)
    state = feed(state, 'á', 1001).state
    state = feed(state, 'á', 1002).state
    expect(feed(state, 'á', 1003).deliver).toBe(true)
  })
})

describe('what must never be dropped (B3-10)', () => {
  it('delivers everything when no composition is armed', () => {
    const state = emptyImeDedupState()
    for (const payload of ['a', 'á', '\x03', 'ls -la\r', '']) {
      expect(feed(state, payload, 5000).deliver).toBe(true)
    }
  })

  it('delivers a deliberately repeated accent, because each has its own composition', () => {
    let state = noteCompositionEnd('á', 1000)
    expect(feed(state, 'á', 1001).deliver).toBe(true)

    state = noteCompositionEnd('á', 1050)
    expect(feed(state, 'á', 1051).deliver).toBe(true)
  })

  it('delivers a payload that merely resembles the composition', () => {
    const state = noteCompositionEnd('á', 1000)
    for (const payload of ['a', 'áb', 'bá', 'Á', 'ááá']) {
      expect(feed(state, payload, 1001).deliver).toBe(true)
    }
  })

  it('delivers once the window has passed, even for an exact match', () => {
    const state = noteCompositionEnd('á', 1000)
    const late = 1000 + IME_DEDUP_WINDOW_MS + 1
    expect(feed(state, 'á', late).deliver).toBe(true)
  })

  it('arms nothing for an empty composition', () => {
    const state = noteCompositionEnd('', 1000)
    expect(state.data).toBeNull()
    expect(feed(state, '', 1001).deliver).toBe(true)
  })

  it('does not let one composition silence a different one', () => {
    let state = noteCompositionEnd('á', 1000)
    state = feed(state, 'á', 1001).state
    state = noteCompositionEnd('ç', 1010)
    expect(feed(state, 'ç', 1011).deliver).toBe(true)
  })
})

