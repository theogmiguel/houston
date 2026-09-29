// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

function topbarLeft(harness: AppHarness): Element {
  const el = harness.container.querySelector('header .flex.items-center.min-w-0')
  if (!el) throw new Error('topbar-left cell not found')
  return el
}

function railToggle(harness: AppHarness): HTMLButtonElement {
  const btn = topbarLeft(harness).querySelector('button')
  if (!btn) throw new Error('rail toggle not found')
  return btn as HTMLButtonElement
}

function railHide(harness: AppHarness): HTMLButtonElement {
  const btn = harness.container.querySelector('aside > div button[aria-label="Hide sidebar"]')
  if (!btn) throw new Error('rail hide button not found in the rail head')
  return btn as HTMLButtonElement
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('rail hide (option A) — hide in the rail head, show in the topbar-left cell', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('open: the rail head carries the "Hide sidebar" control and the topbar-left cell carries none', async () => {
    harness = await renderReadyApp()

    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(topbarLeft(harness).querySelectorAll('button')).toHaveLength(0)
    expect(railHide(harness).getAttribute('aria-label')).toBe('Hide sidebar')
  })

  it('hiding moves the glyph: the rail goes, "Show sidebar" appears in the topbar-left cell, and showing brings the head button back', async () => {
    harness = await renderReadyApp()

    act(() => railHide(harness!).click())
    expect(harness.container.querySelector('aside')).toBeNull()
    const btn = railToggle(harness)
    expect(btn.getAttribute('aria-label')).toBe('Show sidebar')
    expect(topbarLeft(harness).querySelector('[data-testid="brand-mark"]')).toBeNull()

    act(() => railToggle(harness!).click())
    expect(harness.container.querySelector('aside')).not.toBeNull()
    expect(topbarLeft(harness).querySelectorAll('button')).toHaveLength(0)
    expect(railHide(harness).getAttribute('aria-label')).toBe('Hide sidebar')
  })

  it('the railfoot no longer carries a hide control', async () => {
    harness = await renderReadyApp()
    const foot = harness.container.querySelector('.railfoot')
    expect(foot?.querySelector('button[aria-label="Hide sidebar"]')).toBeNull()
  })

  it('Ctrl+B toggles the same way as the click', async () => {
    harness = await renderReadyApp()

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(harness.container.querySelector('aside')).toBeNull()

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
      )
    })
    expect(harness.container.querySelector('aside')).not.toBeNull()
  })

  it('the hidden state survives a remount (localStorage)', async () => {
    harness = await renderReadyApp()
    act(() => railHide(harness!).click())
    expect(harness.container.querySelector('aside')).toBeNull()
    harness.unmount()

    harness = await renderReadyApp()
    expect(harness.container.querySelector('aside')).toBeNull()
    expect(railToggle(harness).getAttribute('aria-label')).toBe('Show sidebar')
  })
})
