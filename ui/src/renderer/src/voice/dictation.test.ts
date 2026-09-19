import { beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_PREAMBLE,
  abandonDictation,
  buildDictationInsert,
  configureDictation,
  dictationFailed,
  dictationTextFor,
  forgetDictationSession,
  resetDictationForTests,
  voiceChordDown,
  voiceChordUp
} from './dictation'

function recorder(captureMode: 'hold' | 'toggle', enabled = true) {
  const calls: string[] = []
  configureDictation({
    enabled,
    captureMode,
    start: (s) => calls.push(`start:${s}`),
    stop: (s) => calls.push(`stop:${s}`)
  })
  return calls
}

beforeEach(() => {
  resetDictationForTests()
})

describe('what lands in the pane (§9)', () => {
  it('ends with a space and never a newline, so dictation cannot submit', () => {
    const out = buildDictationInsert('run the tests', { outputMode: 'original', agentPreamble: true }, false)
    expect(out).toBe('run the tests ')
    expect(out).not.toContain('\n')
    expect(out).not.toContain('\r')
  })

  it('trims what the engine returned rather than pasting its whitespace', () => {
    expect(
      buildDictationInsert('  hello  ', { outputMode: 'original', agentPreamble: false }, false)
    ).toBe('hello ')
  })

  it('inserts nothing at all for an empty transcript', () => {
    expect(
      buildDictationInsert('   ', { outputMode: 'original', agentPreamble: true }, false)
    ).toBe('')
  })

  it('stays silent on the common path: Original never carries the preamble', () => {
    const out = buildDictationInsert('rode os testes', { outputMode: 'original', agentPreamble: true }, false)
    expect(out).toBe('rode os testes ')
    expect(out).not.toContain(AGENT_PREAMBLE)
  })

  it('prefixes the preamble under English, and only for the first dictation', () => {
    const policy = { outputMode: 'english' as const, agentPreamble: true }
    const first = buildDictationInsert('run the tests', policy, false)
    expect(first.startsWith(AGENT_PREAMBLE)).toBe(true)
    expect(first.endsWith('run the tests ')).toBe(true)
    const second = buildDictationInsert('now push it', policy, true)
    expect(second).toBe('now push it ')
  })

  it('honours the toggle: preamble off means no preamble even under English', () => {
    expect(
      buildDictationInsert('run the tests', { outputMode: 'english', agentPreamble: false }, false)
    ).toBe('run the tests ')
  })
})

describe('per-pane preamble bookkeeping', () => {
  const policy = { outputMode: 'english' as const, agentPreamble: true }

  it('fires once per pane, not once per app', () => {
    expect(dictationTextFor(1, 'one', policy).startsWith(AGENT_PREAMBLE)).toBe(true)
    expect(dictationTextFor(1, 'two', policy).startsWith(AGENT_PREAMBLE)).toBe(false)
    expect(dictationTextFor(2, 'three', policy).startsWith(AGENT_PREAMBLE)).toBe(true)
  })

  it('does not burn the first-time slot on an empty transcript', () => {
    expect(dictationTextFor(1, '  ', policy)).toBe('')
    expect(dictationTextFor(1, 'the real one', policy).startsWith(AGENT_PREAMBLE)).toBe(true)
  })

  it('forgets a closed pane, so a reused indicator never inherits its state', () => {
    dictationTextFor(1, 'one', policy)
    forgetDictationSession(1)
    expect(dictationTextFor(1, 'two', policy).startsWith(AGENT_PREAMBLE)).toBe(true)
  })
})

describe('the chord (§8)', () => {
  it('does nothing at all while dictation is disabled', () => {
    const calls = recorder('hold', false)
    expect(voiceChordDown(3)).toBe(false)
    expect(voiceChordUp(3)).toBe(false)
    expect(calls).toEqual([])
  })

  it('does nothing when no controller is configured (no client, no connection)', () => {
    configureDictation(null)
    expect(voiceChordDown(3)).toBe(false)
    expect(voiceChordUp(3)).toBe(false)
  })

  it('hold: starts on the way down and stops on the way up', () => {
    const calls = recorder('hold')
    expect(voiceChordDown(7)).toBe(true)
    expect(voiceChordUp(7)).toBe(true)
    expect(calls).toEqual(['start:7', 'stop:7'])
  })

  it('hold: the browser’s auto-repeat keydown does not restart the capture', () => {
    const calls = recorder('hold')
    voiceChordDown(7)
    voiceChordDown(7)
    voiceChordDown(7)
    voiceChordUp(7)
    expect(calls).toEqual(['start:7', 'stop:7'])
  })

  it('hold: a release for a pane that was not holding is ignored', () => {
    const calls = recorder('hold')
    voiceChordDown(7)
    expect(voiceChordUp(9)).toBe(false)
    expect(calls).toEqual(['start:7'])
  })

  it('toggle: two presses bracket one dictation, and the release does nothing', () => {
    const calls = recorder('toggle')
    voiceChordDown(4)
    expect(voiceChordUp(4)).toBe(false)
    voiceChordDown(4)
    expect(calls).toEqual(['start:4', 'stop:4'])
  })

  it('toggle: pressing in a second pane ends the first rather than capturing twice', () => {
    const calls = recorder('toggle')
    voiceChordDown(4)
    voiceChordDown(5)
    expect(calls).toEqual(['start:4', 'stop:4'])
  })

  it('abandoning a held pane stops the capture', () => {
    const calls = recorder('hold')
    voiceChordDown(7)
    abandonDictation(7)
    expect(calls).toEqual(['start:7', 'stop:7'])
    expect(voiceChordUp(7)).toBe(false)
    expect(calls).toEqual(['start:7', 'stop:7'])
  })

  it('disabling dictation drops a running toggle instead of stranding it', () => {
    const calls = recorder('toggle')
    voiceChordDown(4)
    configureDictation(null)
    const after = recorder('toggle')
    voiceChordDown(4)
    expect(calls).toEqual(['start:4'])
    expect(after).toEqual(['start:4'])
  })

  describe('dictationFailed (a start that never took)', () => {
    it('releases a held pane so the next press is a fresh start, with no stop sent', () => {
      const calls = recorder('hold')
      voiceChordDown(7)
      dictationFailed(7)
      expect(calls).toEqual(['start:7'])
      voiceChordDown(7)
      expect(calls).toEqual(['start:7', 'start:7'])
    })

    it('drops a booked toggle so the next press starts rather than stops', () => {
      const calls = recorder('toggle')
      voiceChordDown(4)
      dictationFailed(4)
      expect(calls).toEqual(['start:4'])
      voiceChordDown(4)
      expect(calls).toEqual(['start:4', 'start:4'])
    })

    it('leaves another pane’s hold alone', () => {
      const calls = recorder('hold')
      voiceChordDown(7)
      dictationFailed(9)
      voiceChordUp(7)
      expect(calls).toEqual(['start:7', 'stop:7'])
    })
  })
})
