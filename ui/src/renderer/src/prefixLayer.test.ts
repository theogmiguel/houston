// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forwardLayerKey,
  isLayerKey,
  PREFIX_TIMEOUT_MS,
  prefixLayer
} from './prefixLayer'

describe('prefixLayer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    prefixLayer.disarm()
  })
  afterEach(() => {
    prefixLayer.disarm()
    vi.useRealTimers()
  })

  it('the safety net is 8 s: armed at 7999 ms, down at 8000 ms', () => {
    prefixLayer.arm()
    vi.advanceTimersByTime(7999)
    expect(prefixLayer.isArmed()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(prefixLayer.isArmed()).toBe(false)
  })

  it('arms, notifies, and disarms itself after the timeout', () => {
    const seen: boolean[] = []
    const off = prefixLayer.subscribe(() => seen.push(prefixLayer.isArmed()))
    prefixLayer.arm()
    expect(prefixLayer.isArmed()).toBe(true)
    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 1)
    expect(prefixLayer.isArmed()).toBe(true)
    vi.advanceTimersByTime(1)
    expect(prefixLayer.isArmed()).toBe(false)
    expect(seen).toEqual([true, false])
    off()
  })

  it('re-arming restarts the timeout', () => {
    prefixLayer.arm()
    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 10)
    prefixLayer.arm()
    vi.advanceTimersByTime(PREFIX_TIMEOUT_MS - 10)
    expect(prefixLayer.isArmed()).toBe(true)
  })

  it('disarm is idempotent and notifies once', () => {
    const l = vi.fn()
    const off = prefixLayer.subscribe(l)
    prefixLayer.arm()
    prefixLayer.disarm()
    prefixLayer.disarm()
    expect(l).toHaveBeenCalledTimes(2)
    off()
  })

  it('forwardLayerKey re-emits a marked keydown on window with the same chord', () => {
    const got: KeyboardEvent[] = []
    const on = (e: Event): void => {
      got.push(e as KeyboardEvent)
    }
    window.addEventListener('keydown', on)
    forwardLayerKey(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', shiftKey: true }))
    window.removeEventListener('keydown', on)
    expect(got).toHaveLength(1)
    expect(got[0].key).toBe('n')
    expect(got[0].code).toBe('KeyN')
    expect(got[0].shiftKey).toBe(true)
    expect(got[0].ctrlKey).toBe(false)
    expect(isLayerKey(got[0])).toBe(true)
    expect(isLayerKey(new KeyboardEvent('keydown', { key: 'n' }))).toBe(false)
  })
})
