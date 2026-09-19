// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  renderReadyApp,
  resetHarness,
  engineCounts,
  toggleSettings
} from './test/appTestHarness'

beforeEach(() => {
  localStorage.clear()
  resetHarness()
})

describe('App grid-slot / Settings overlay wiring (P4 #27)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('keeps the grid mounted and drives both the wrapper class and the per-leaf hidden style across a Settings open/close round trip', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    const gridSlot = (): Element | null => container.querySelector('.grid-slot')
    const paneSlot = (): HTMLElement | null =>
      container.querySelector('.pane-slot') as HTMLElement | null

    expect(gridSlot()).not.toBeNull()
    expect(paneSlot()).not.toBeNull()
    expect(engineCounts()).toEqual({ constructed: 1, disposed: 0 })

    expect(gridSlot()?.className).not.toContain('grid-hidden')
    expect(paneSlot()?.style.visibility).not.toBe('hidden')

    toggleSettings()

    expect(engineCounts()).toEqual({ constructed: 1, disposed: 0 })
    expect(gridSlot()?.className).toContain('grid-hidden')
    expect(paneSlot()?.style.visibility).toBe('hidden')

    toggleSettings()

    expect(engineCounts()).toEqual({ constructed: 1, disposed: 0 })
    expect(gridSlot()).not.toBeNull()
    expect(paneSlot()).not.toBeNull()
    expect(gridSlot()?.className).not.toContain('grid-hidden')
    expect(paneSlot()?.style.visibility).not.toBe('hidden')
  })
})
