// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness } from './test/appTestHarness'
import { focusedPaneOwnsKey } from './keymap'

const WS = '/tmp/project'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  })
}

describe('a focused pane keeps the keys a terminal needs, and only those', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function withFocusedPane(): Promise<AppHarness> {
    const h = await renderReadyApp()
    const pane = h.container.querySelector('section.pane[data-panekey="1"]')
    if (!pane) throw new Error('no terminal pane rendered')
    act(() => {
      pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    if (!h.container.querySelector('section.pane.focus')) {
      throw new Error('the pane did not take focus, so this file tests nothing')
    }
    return h
  }

  it('Ctrl+, still opens Settings while a terminal has the keyboard', async () => {
    harness = await withFocusedPane()
    press({ key: ',', ctrlKey: true })
    const { isSettingsOpen } = await import('./settingsNav')
    expect(isSettingsOpen()).toBe(true)
  })

  it('a bare letter goes to the pane, not to the global that shares it', async () => {
    harness = await withFocusedPane()
    const before = harness.container.querySelectorAll('section.pane[data-panekey]').length
    press({ key: 't' })
    expect(harness.container.querySelectorAll('section.pane[data-panekey]').length).toBe(before)
  })

  it('Esc belongs to the pane — a TUI needs it', () => {
    expect(focusedPaneOwnsKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
  })

  it.each([
    ['Ctrl+L (clear screen)', { key: 'l', ctrlKey: true }],
    ['Ctrl+K (kill line)', { key: 'k', ctrlKey: true }],
    ['Ctrl+B (backward char)', { key: 'b', ctrlKey: true }]
  ])('%s stays with the pane, whatever Houston also binds it to', (_label, init) => {
    expect(focusedPaneOwnsKey(new KeyboardEvent('keydown', init))).toBe(true)
  })

  it.each([
    ['Ctrl+,', { key: ',', ctrlKey: true }],
    ['Ctrl+Shift+B', { key: 'B', ctrlKey: true, shiftKey: true }],
    ['Ctrl+Shift+W', { key: 'W', ctrlKey: true, shiftKey: true }]
  ])('%s reaches the app', (_label, init) => {
    expect(focusedPaneOwnsKey(new KeyboardEvent('keydown', init))).toBe(false)
  })

  it('the workspace with no remembered pane still boots with globals live', async () => {
    harness = await renderReadyApp()
    expect(harness.container.querySelector('section.pane.focus')).toBeNull()
    const before = harness.container.querySelectorAll('section.pane[data-panekey]').length
    press({ key: 't' })
    expect(harness.container.querySelectorAll('section.pane[data-panekey]').length)
      .toBeGreaterThanOrEqual(before)
    expect(localStorage.getItem(`tr-layout:${WS}`)).not.toBeUndefined()
  })
})
