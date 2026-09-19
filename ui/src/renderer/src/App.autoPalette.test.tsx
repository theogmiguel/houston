// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'
import { pickOption, selectOptionLabels, selectValue } from './test/selectHarness'
import { DEFAULT_CHROME_THEME, DEFAULT_TERMINAL_PALETTE_FOR_CHROME, THEME_LABELS } from './theme'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openSettings(): Promise<void> {
  toggleSettings()
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings'
  )
}

function openAppearance(): void {
  act(() => setSettingsNavForTests({ section: 'appearance' }))
}

const PALETTE = 'palette-select'

function chromeTile(container: HTMLElement, pref: string): HTMLButtonElement {
  const group = container.querySelector('[role="radiogroup"][aria-label="Chrome theme"]')
  if (!group) throw new Error('chrome theme control not found')
  const tile = group.querySelector(`[data-chrome-theme="${pref}"]`)
  if (!(tile instanceof HTMLButtonElement)) throw new Error(`no chrome tile for ${pref}`)
  return tile
}

describe('Auto terminal-palette option', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('is selected by default on a fresh profile and names what it resolves to', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openAppearance()

    const autoLabel = `Auto — ${THEME_LABELS[DEFAULT_TERMINAL_PALETTE_FOR_CHROME[DEFAULT_CHROME_THEME]]}`
    expect(selectValue(container, PALETTE)).toBe(autoLabel)
    expect(selectOptionLabels(container, PALETTE)[0]).toBe(autoLabel)
  })

  it('re-resolves live when the chrome theme switches, and stays selected', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openAppearance()

    act(() => chromeTile(container, 'paper').click())

    const autoLabel = `Auto — ${THEME_LABELS[DEFAULT_TERMINAL_PALETTE_FOR_CHROME.paper]}`
    expect(selectValue(container, PALETTE)).toBe(autoLabel)
    expect(selectOptionLabels(container, PALETTE)[0]).toBe(autoLabel)
  })

  it('picking a concrete palette pins it, no longer following chrome switches', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openAppearance()

    pickOption(container, PALETTE, 'dracula')

    expect(selectValue(container, PALETTE)).toBe(THEME_LABELS.dracula)
    expect(localStorage.getItem('tr-theme')).toBe('dracula')

    act(() => chromeTile(container, 'paper').click())

    expect(localStorage.getItem('tr-theme')).toBe('dracula')
    expect(selectValue(container, PALETTE)).toBe(THEME_LABELS.dracula)
  })

  it('the chip strip fingerprints the palette actually in force', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openAppearance()

    const chips = container.querySelectorAll('[data-testid="palette-chips"] i')
    expect(chips).toHaveLength(8)
    expect([...chips].every((c) => (c as HTMLElement).style.background !== '')).toBe(true)
  })
})
