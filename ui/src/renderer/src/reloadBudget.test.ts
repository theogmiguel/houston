// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAndReload, reloadStormDetected, resetReloadBudget } from './reloadBudget'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('reload budget window (widened from 60s to 10min to match Rust)', () => {
  it('still counts 3 reloads spaced beyond the old 60s window as inside budget', () => {
    vi.setSystemTime(0)
    recordAndReload()
    vi.setSystemTime(30_000)
    recordAndReload()
    vi.setSystemTime(90_000)
    recordAndReload()

    expect(reloadStormDetected()).toBe(true)
  })

  it('drops out of budget once outside the new 10 minute window', () => {
    vi.setSystemTime(0)
    recordAndReload()
    recordAndReload()
    recordAndReload()
    expect(reloadStormDetected()).toBe(true)

    vi.setSystemTime(10 * 60_000 + 1)
    expect(reloadStormDetected()).toBe(false)
  })

  it('resetReloadBudget clears the record so the storm no longer detects', () => {
    recordAndReload()
    recordAndReload()
    recordAndReload()
    expect(reloadStormDetected()).toBe(true)

    resetReloadBudget()
    expect(reloadStormDetected()).toBe(false)
  })
})
