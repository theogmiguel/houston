// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppHarness,
  renderReadyApp,
  resetHarness,
  settleLazySurface
} from './test/appTestHarness'

const { focusCb } = vi.hoisted(() => ({
  focusCb: { current: null as ((id: string) => void) | null }
}))
vi.mock('./houston/browserFocus', () => ({
  useBrowserFocus: (cb: (id: string) => void) => {
    focusCb.current = cb
  }
}))

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  focusCb.current = null
})

function fireNativeFocus(id: string): void {
  if (!focusCb.current) throw new Error('App never subscribed via useBrowserFocus')
  act(() => focusCb.current!(id))
}

async function openBrowserPane(h: AppHarness): Promise<HTMLElement> {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
    )
  })
  await settleLazySurface(
    () => h.container.querySelector('section.pane.browser') !== null,
    'BrowserPane'
  )
  const pane = h.container.querySelector('section.pane.browser')
  if (!(pane instanceof HTMLElement)) throw new Error('no browser pane rendered')
  return pane
}

function terminalPane(h: AppHarness): HTMLElement {
  const pane = Array.from(h.container.querySelectorAll<HTMLElement>('.pane')).find((p) =>
    /^\d+$/.test(p.getAttribute('data-panekey') ?? '')
  )
  if (!pane) throw new Error('no terminal pane rendered')
  return pane
}

describe('a native click inside a browser page selects the pane (M9 item 4)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('gives the clicked pane the ring and takes it from the terminal', async () => {
    harness = await renderReadyApp()
    const browser = await openBrowserPane(harness)
    const terminal = terminalPane(harness)

    act(() => {
      terminal.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    expect(terminal.classList.contains('focus')).toBe(true)
    expect(browser.classList.contains('focus')).toBe(false)

    fireNativeFocus(browser.getAttribute('data-panekey')!)

    expect(browser.classList.contains('focus')).toBe(true)
    expect(terminal.classList.contains('focus')).toBe(false)
  })

  it('re-arms the bare-letter globals the stuck terminal selection disabled', async () => {
    harness = await renderReadyApp()
    const browser = await openBrowserPane(harness)
    act(() => {
      terminalPane(harness!).dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
      )
    })

    fireNativeFocus(browser.getAttribute('data-panekey')!)

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
      )
    })
    expect(harness.container.querySelectorAll('section.pane.browser')).toHaveLength(2)
  })

  it('treats a surface outside the viewed layout as a click outside any pane', async () => {
    harness = await renderReadyApp()
    const browser = await openBrowserPane(harness)
    fireNativeFocus(browser.getAttribute('data-panekey')!)
    expect(browser.classList.contains('focus')).toBe(true)

    fireNativeFocus('right-panel-browser')

    expect(browser.classList.contains('focus')).toBe(false)
  })
})
