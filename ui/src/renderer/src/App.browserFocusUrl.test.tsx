// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverControl,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function press(init: Partial<KeyboardEventInit>, target?: EventTarget): void {
  act(() => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    ;(target ?? window).dispatchEvent(e)
  })
}

describe('Ctrl+L focuses the browser address bar', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function openBrowserPanel(h: AppHarness): Promise<HTMLInputElement> {
    press({ key: 'B', ctrlKey: true, shiftKey: true })
    const browserEntry = h.container.querySelector('[data-pane-kind="browser"]')
    if (!browserEntry) throw new Error('no Browser entry in the Add-pane menu')
    act(() => {
      browserEntry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await settleLazySurface(
      () => h.container.querySelector('input[aria-label="Address and search bar"]') !== null,
      'BrowserPane'
    )
    const url = h.container.querySelector('input[aria-label="Address and search bar"]')
    if (!(url instanceof HTMLInputElement)) throw new Error('browser pane did not open')
    const pane = url.closest('.pane')
    if (!pane) throw new Error('browser pane has no .pane ancestor')
    act(() => {
      pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    return url
  }

  it('focuses the address bar when the browser panel is showing', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)
    expect(document.activeElement).not.toBe(url)

    press({ key: 'l', ctrlKey: true })

    expect(document.activeElement).toBe(url)
  })

  it('leaves the keystroke alone when a text field elsewhere has focus', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)

    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    try {
      const e = new KeyboardEvent('keydown', {
        key: 'l',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      act(() => {
        other.dispatchEvent(e)
      })

      expect(document.activeElement).toBe(other)
      expect(document.activeElement).not.toBe(url)
      expect(e.defaultPrevented).toBe(false)
    } finally {
      other.remove()
    }
  })

  it('leaves the keystroke alone for a textarea, which is how xterm takes keys', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)

    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    try {
      const e = new KeyboardEvent('keydown', {
        key: 'l',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      act(() => {
        ta.dispatchEvent(e)
      })

      expect(document.activeElement).toBe(ta)
      expect(document.activeElement).not.toBe(url)
      expect(e.defaultPrevented).toBe(false)
    } finally {
      ta.remove()
    }
  })

  it('does nothing while an overlay owns the screen', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)

    press({ key: ',', ctrlKey: true })
    press({ key: 'l', ctrlKey: true })
    expect(document.activeElement).not.toBe(url)

    press({ key: ',', ctrlKey: true })
    press({ key: 'l', ctrlKey: true })
    expect(document.activeElement).toBe(url)
  })

  it('does nothing while the browser pane is not the active leaf', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)
    act(() => {
      harness!.container
        .querySelector('.layout')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })

    press({ key: 'l', ctrlKey: true })

    expect(document.activeElement).not.toBe(url)
  })

  it('leaves Ctrl+Shift+L alone', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)

    press({ key: 'L', ctrlKey: true, shiftKey: true })
    press({ key: 'l', ctrlKey: true, altKey: true })

    expect(document.activeElement).not.toBe(url)
  })

  it('respects the global shortcuts kill-switch', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)
    deliverControl({ type: 'keymap', overrides: { bindings: {}, shortcuts_enabled: false } })

    press({ key: 'l', ctrlKey: true })

    expect(document.activeElement).not.toBe(url)
  })

  it('follows a remapped chord', async () => {
    harness = await renderReadyApp()
    const url = await openBrowserPanel(harness)
    deliverControl({
      type: 'keymap',
      overrides: {
        bindings: {
          'browser-focus-url': { code: 'KeyK', ctrl: true, alt: false, shift: false, meta: false }
        },
        shortcuts_enabled: true
      }
    })

    press({ key: 'l', ctrlKey: true })
    expect(document.activeElement).not.toBe(url)

    press({ code: 'KeyK', key: 'k', ctrlKey: true })
    expect(document.activeElement).toBe(url)
  })
})
