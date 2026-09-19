// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

const ANIM_OUT_EXIT_MS = 170

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function pressCtrlK(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
    )
  })
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
}

function palette(h: AppHarness): HTMLElement | null {
  return h.container.querySelector('[data-testid="command-palette"]')
}

describe('command palette mount (palette-01, Ctrl+K)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('is unreachable before this gap: nothing renders it without the chord', async () => {
    harness = await renderReadyApp()
    expect(palette(harness)).toBeNull()
  })

  it('Ctrl+K opens it', async () => {
    harness = await renderReadyApp()
    expect(palette(harness)).toBeNull()
    pressCtrlK()
    expect(palette(harness)).not.toBeNull()
  })

  it('Escape closes it', async () => {
    harness = await renderReadyApp()
    pressCtrlK()
    expect(palette(harness)).not.toBeNull()
    vi.useFakeTimers()
    try {
      pressEscape()
      act(() => vi.advanceTimersByTime(ANIM_OUT_EXIT_MS))
      expect(palette(harness)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists real registry commands, not an empty shell — e.g. "New terminal"', async () => {
    harness = await renderReadyApp()
    pressCtrlK()
    const rows = Array.from(harness!.container.querySelectorAll('[data-testid="command-palette-row"]'))
    expect(rows.some((r) => r.textContent?.includes('New terminal'))).toBe(true)
  })

  it('running a command (New terminal) both creates a session and closes the palette', async () => {
    harness = await renderReadyApp()
    const { currentClient } = await import('./test/appTestHarness')
    const createSession = currentClient().createSession as unknown as import('vitest').Mock
    createSession.mockClear()
    pressCtrlK()
    const row = Array.from(harness!.container.querySelectorAll('[data-testid="command-palette-row"]')).find(
      (r) => r.textContent?.includes('New terminal')
    )
    if (!row) throw new Error('"New terminal" row not found in the palette')
    vi.useFakeTimers()
    try {
      act(() => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      expect(createSession).toHaveBeenCalledTimes(1)
      act(() => vi.advanceTimersByTime(ANIM_OUT_EXIT_MS))
      expect(palette(harness)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
