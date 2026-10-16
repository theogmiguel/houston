// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettledSmartCards } from './useSettledSmartCards'

describe('useSettledSmartCards', () => {
  let container: HTMLDivElement
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    vi.useRealTimers()
    container.remove()
  })

  function mount(): { set: (value: number, enabled?: boolean) => void; read: () => number } {
    let current = 0
    const root = createRoot(container)
    function Probe({ value, enabled }: { value: number; enabled: boolean }): null {
      current = useSettledSmartCards(value, enabled, 3000)
      return null
    }
    return {
      set: (value, enabled = true) => act(() => root.render(<Probe value={value} enabled={enabled} />)),
      read: () => current,
    }
  }

  it('settles under a steady stream of updates instead of waiting for quiet', () => {
    const probe = mount()
    probe.set(0)
    for (let value = 1; value <= 10; value += 1) {
      probe.set(value)
      act(() => { vi.advanceTimersByTime(1000) })
    }
    expect(probe.read()).toBeGreaterThanOrEqual(3)
    expect(probe.read()).toBeLessThanOrEqual(10)
  })

  it('holds the snapshot until the delay has passed', () => {
    const probe = mount()
    probe.set(0)
    probe.set(5)
    expect(probe.read()).toBe(0)
    act(() => { vi.advanceTimersByTime(2999) })
    expect(probe.read()).toBe(0)
    act(() => { vi.advanceTimersByTime(2) })
    expect(probe.read()).toBe(5)
  })

  it('follows the live value at once when disabled', () => {
    const probe = mount()
    probe.set(0, false)
    probe.set(9, false)
    expect(probe.read()).toBe(9)
  })
})
