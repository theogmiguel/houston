// @vitest-environment jsdom

import { act, render, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgeLabel, useAgeNow } from './ageTicker'

describe('age ticker', () => {
  afterEach(() => vi.useRealTimers())

  it('starts on the first subscriber and stops after the last unsubscribes', () => {
    vi.useFakeTimers()
    const first = renderHook(() => useAgeNow(true))
    expect(vi.getTimerCount()).toBe(1)

    const second = renderHook(() => useAgeNow(true))
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1000))
    expect(second.result.current).toBe(first.result.current)

    first.unmount()
    expect(vi.getTimerCount()).toBe(1)
    second.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not subscribe settled ages', () => {
    vi.useFakeTimers()
    const settled = renderHook(() => useAgeNow(false))
    expect(vi.getTimerCount()).toBe(0)
    settled.unmount()
  })

  it('shows the current age when the first subscriber restarts the ticker', () => {
    vi.useFakeTimers()
    const start = Date.now()
    act(() => vi.advanceTimersByTime(10_000))

    const age = render(createElement(AgeLabel, { start, ticking: true }))

    expect(age.container.textContent).toBe('10s')
    age.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
