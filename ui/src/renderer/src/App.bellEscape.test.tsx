// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

let harness: AppHarness | null = null

afterEach(() => {
  harness?.unmount()
  harness = null
})

function bellButton(h: AppHarness): HTMLButtonElement {
  const btn = Array.from(h.container.querySelectorAll('button')).find((b) =>
    b.className.includes('bell-btn')
  )
  if (!btn) throw new Error('bell button not found')
  return btn as HTMLButtonElement
}

function bellIsOpen(h: AppHarness): boolean {
  return bellButton(h).className.includes('on-accent')
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
}

describe('bell panel answers Escape (E-toast-2)', () => {
  it('closes on Escape, with a session present and selected', async () => {
    harness = await renderReadyApp()
    act(() => {
      bellButton(harness!).click()
    })
    expect(bellIsOpen(harness)).toBe(true)

    pressEscape()

    expect(bellIsOpen(harness)).toBe(false)
  })

  it('does not swallow Escape while the panel is closed', async () => {
    harness = await renderReadyApp()
    expect(bellIsOpen(harness)).toBe(false)

    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      window.dispatchEvent(e)
    })
    expect(e.defaultPrevented).toBe(false)
    expect(bellIsOpen(harness)).toBe(false)
  })

  it('is idempotent — a second Escape does not reopen it', async () => {
    harness = await renderReadyApp()
    act(() => {
      bellButton(harness!).click()
    })
    pressEscape()
    pressEscape()
    expect(bellIsOpen(harness)).toBe(false)
  })
})
