// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AppHarness,
  deliverHelloOk,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'
const LEAF = 'b-cleanup'
const TABS_KEY = `tr-browser-tabs.leaf.${LEAF}`
const SEEDED_TABS = JSON.stringify({
  tabs: [{ id: 1, url: 'https://example.test/' }],
  activeTabId: 1
})

function seed(): void {
  localStorage.setItem(
    `tr-layout:${WS}`,
    JSON.stringify({
      customized: true,
      cols: 2,
      tree: {
        kind: 'split',
        dir: 'row',
        weights: [50, 50],
        children: [
          { kind: 'leaf', session: 1 },
          { kind: 'browser', id: LEAF, url: 'https://example.test/' }
        ]
      }
    })
  )
  localStorage.setItem(TABS_KEY, SEEDED_TABS)
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
  seed()
})

describe("a closed browser pane's tab store (M9)", () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('is deleted when the user closes the pane', async () => {
    harness = await renderReadyApp()
    expect(localStorage.getItem(TABS_KEY)).toBe(SEEDED_TABS)

    const pane = harness.container.querySelector('.pane.browser')
    if (!(pane instanceof HTMLElement)) throw new Error('no browser pane rendered')
    const close = Array.from(pane.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close')
    if (!close) throw new Error('no Close button on the browser pane')
    act(() => close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(harness.container.querySelector('.pane.browser')).toBeNull()
    expect(localStorage.getItem(TABS_KEY)).toBeNull()
  })

  it('survives an unmount, which is what a reload is', async () => {
    harness = await renderReadyApp()
    harness.unmount()
    harness = null

    expect(localStorage.getItem(TABS_KEY)).toBe(SEEDED_TABS)

    harness = await renderReadyApp()
    expect(harness.container.querySelector('.pane.browser')).not.toBeNull()
    expect(localStorage.getItem(TABS_KEY)).toBe(SEEDED_TABS)
  })

  it('is deleted when the whole workspace is closed', async () => {
    harness = await renderReadyApp()
    expect(localStorage.getItem(TABS_KEY)).toBe(SEEDED_TABS)

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true })
      )
    })
    const modal = harness.container.querySelector('[role="alertdialog"]')
    if (!modal) throw new Error('no close-workspace confirmation shown')
    const confirm = Array.from(modal.querySelectorAll('button')).find((b) =>
      /close workspace|discard and close/i.test(b.textContent ?? '')
    )
    if (!confirm) throw new Error('no confirm button in the close-workspace dialog')
    act(() => confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(localStorage.getItem(`tr-layout:${WS}`)).toBeNull()
    expect(localStorage.getItem(TABS_KEY)).toBeNull()
  })

  it('closes even when it is the only pane left (M9 item 3)', async () => {
    localStorage.setItem(
      `tr-layout:${WS}`,
      JSON.stringify({
        customized: true,
        cols: 2,
        tree: { kind: 'browser', id: LEAF, url: 'https://example.test/' }
      })
    )
    harness = await renderReadyApp()
    deliverHelloOk({ sessions: [], workspaces: [makeWorkspace()] })
    const pane = harness.container.querySelector('.pane.browser')
    if (!(pane instanceof HTMLElement)) throw new Error('no browser pane rendered')
    const close = Array.from(pane.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close')
    if (!close) throw new Error('no Close button on the browser pane')
    act(() => close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(harness.container.querySelector('.pane.browser')).toBeNull()
    expect(localStorage.getItem(TABS_KEY)).toBeNull()
  })

  it('leaves other panes’ stores alone', async () => {
    const otherKey = 'tr-browser-tabs.leaf.b-other'
    localStorage.setItem(otherKey, SEEDED_TABS)
    harness = await renderReadyApp()

    const pane = harness.container.querySelector('.pane.browser') as HTMLElement
    const close = Array.from(pane.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Close')!
    act(() => close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(localStorage.getItem(TABS_KEY)).toBeNull()
    expect(localStorage.getItem(otherKey)).toBe(SEEDED_TABS)
  })
})
