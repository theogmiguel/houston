import { beforeEach, describe, expect, it } from 'vitest'
import type { VoiceFailure } from '../houston/generated/VoiceFailure'
import {
  insertVoiceText,
  isPersistentVoiceFailure,
  registerVoiceInsert,
  resetVoiceStoreForTests,
  voiceFailureMessage,
  voiceIndicatorFor,
  setVoiceIndicator,
  clearVoiceIndicators
} from './store'

beforeEach(() => {
  resetVoiceStoreForTests()
})

describe('§11 failure copy carries its numbers', () => {
  it('too quiet shows the measured RMS and the floor it missed', () => {
    const msg = voiceFailureMessage({ kind: 'too_quiet', rms: 0.0031, floor: 0.01 })
    expect(msg).toContain('0.0031')
    expect(msg).toContain('0.0100')
  })

  it('too short shows the captured length and the minimum', () => {
    const msg = voiceFailureMessage({ kind: 'too_short', seconds: 0.12, minimum: 0.3 })
    expect(msg).toContain('0.12')
    expect(msg).toContain('0.30')
  })

  it('a ring overrun says how many samples were lost, and that the text has a gap', () => {
    const msg = voiceFailureMessage({ kind: 'ring_buffer_overrun', dropped: 4096 })
    expect(msg).toContain('4096')
    expect(msg.toLowerCase()).toContain('gap')
  })

  it('a missing model names it and points at where to fix it', () => {
    const msg = voiceFailureMessage({ kind: 'no_model', model_id: 'ggml-small' })
    expect(msg).toContain('ggml-small')
    expect(msg).toContain('Settings')
  })

  it('a dead device names the device rather than saying "an error occurred"', () => {
    const msg = voiceFailureMessage({
      kind: 'device_unavailable',
      device: 'Blue Yeti (Device or resource busy)'
    })
    expect(msg).toContain('Blue Yeti')
    expect(msg).toContain('Device or resource busy')
  })

  it('a dead target says the text was DROPPED, not redirected', () => {
    const msg = voiceFailureMessage({ kind: 'target_gone', session: 12 })
    expect(msg).toContain('12')
    expect(msg.toLowerCase()).toContain('dropped')
  })

  it('splits the failures that live on the Settings page from the momentary ones', () => {
    const persistent: VoiceFailure[] = [
      { kind: 'no_model', model_id: 'ggml-small' },
      { kind: 'missing_key', provider: 'groq' },
      { kind: 'device_unavailable', device: 'x' }
    ]
    const momentary: VoiceFailure[] = [
      { kind: 'too_quiet', rms: 0, floor: 0.01 },
      { kind: 'too_short', seconds: 0.1, minimum: 0.3 },
      { kind: 'no_speech' },
      { kind: 'ring_buffer_overrun', dropped: 1 },
      { kind: 'target_gone', session: 1 }
    ]
    for (const f of persistent) expect(isPersistentVoiceFailure(f), f.kind).toBe(true)
    for (const f of momentary) expect(isPersistentVoiceFailure(f), f.kind).toBe(false)
  })
})

describe('insertion registry', () => {
  it('delivers to the named pane and to no other', () => {
    const seen: Array<[number, string]> = []
    registerVoiceInsert(1, (t) => (seen.push([1, t]), true))
    registerVoiceInsert(2, (t) => (seen.push([2, t]), true))
    expect(insertVoiceText(2, 'hello ')).toBe(true)
    expect(seen).toEqual([[2, 'hello ']])
  })

  it('reports failure rather than redirecting when the pane is gone', () => {
    const seen: string[] = []
    registerVoiceInsert(1, (t) => (seen.push(t), true))
    expect(insertVoiceText(9, 'hello ')).toBe(false)
    expect(seen).toEqual([])
  })

  it('unregistering really removes the pane, so an unmounted terminal is never reached', () => {
    const off = registerVoiceInsert(1, () => true)
    off()
    expect(insertVoiceText(1, 'x ')).toBe(false)
  })
})

describe('indicators', () => {
  it('clearing removes every pane’s indicator — an indicator must not outlive its stream', () => {
    setVoiceIndicator(1, { kind: 'listening' })
    setVoiceIndicator(2, { kind: 'transcribing' })
    clearVoiceIndicators()
    expect(voiceIndicatorFor(1)).toBeNull()
    expect(voiceIndicatorFor(2)).toBeNull()
  })
})
