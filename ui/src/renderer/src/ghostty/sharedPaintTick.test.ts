import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SharedPaintTick } from './sharedPaintTick'

const ownerA = {}
const ownerB = {}

describe('SharedPaintTick', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('paints every scheduled owner once, together, after one interval', () => {
    const tick = new SharedPaintTick(() => 66)
    const a = vi.fn()
    const b = vi.fn()
    tick.schedule(ownerA, a)
    vi.advanceTimersByTime(30)
    tick.schedule(ownerB, b)
    tick.schedule(ownerA, a)
    vi.advanceTimersByTime(35)
    expect(a).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh interval for requests after a flush', () => {
    const tick = new SharedPaintTick(() => 66)
    const a = vi.fn()
    tick.schedule(ownerA, a)
    vi.advanceTimersByTime(66)
    tick.schedule(ownerA, a)
    vi.advanceTimersByTime(65)
    expect(a).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(a).toHaveBeenCalledTimes(2)
  })

  it('drops a cancelled owner without disturbing the others', () => {
    const tick = new SharedPaintTick(() => 66)
    const a = vi.fn()
    const b = vi.fn()
    tick.schedule(ownerA, a)
    tick.schedule(ownerB, b)
    tick.cancel(ownerA)
    vi.advanceTimersByTime(66)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
