// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const ANIM_OUT_EXIT_MS = 170

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function tidyButton(h: AppHarness): HTMLButtonElement {
  const btn = h.container.querySelector('[aria-label="Tidy panes"]')
  if (!btn) throw new Error('tidy button not found')
  return btn as HTMLButtonElement
}

function bellButton(h: AppHarness): HTMLButtonElement {
  const btn = Array.from(h.container.querySelectorAll('button')).find((b) =>
    b.className.includes('bell-btn')
  )
  if (!btn) throw new Error('bell button not found')
  return btn as HTMLButtonElement
}

function isOn(el: HTMLElement): boolean {
  return el.className.includes('on-accent')
}

function pressCtrlK(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    )
  })
}

describe('bell popover + palette — one overlay at a time (overlays-05)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('opening the command palette (Ctrl+K) closes an open bell popover', async () => {
    harness = await renderReadyApp()
    act(() => bellButton(harness!).click())
    expect(isOn(bellButton(harness))).toBe(true)

    pressCtrlK()
    expect(harness.container.querySelector('[data-testid="command-palette"]')).not.toBeNull()
    expect(isOn(bellButton(harness))).toBe(false)
  })

  it('clicking the bell while the palette is open closes the palette', async () => {
    harness = await renderReadyApp()
    pressCtrlK()
    expect(harness.container.querySelector('[data-testid="command-palette"]')).not.toBeNull()

    vi.useFakeTimers()
    try {
      act(() => bellButton(harness!).click())
      expect(isOn(bellButton(harness))).toBe(true)
      act(() => vi.advanceTimersByTime(ANIM_OUT_EXIT_MS))
      expect(harness.container.querySelector('[data-testid="command-palette"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Tidy is an action, not an overlay — it opens nothing and closes nothing', async () => {
    harness = await renderReadyApp()
    act(() => bellButton(harness!).click())
    expect(isOn(bellButton(harness))).toBe(true)

    act(() => tidyButton(harness!).click())
    expect(isOn(tidyButton(harness))).toBe(false)
    expect(isOn(bellButton(harness))).toBe(true)
  })
})
