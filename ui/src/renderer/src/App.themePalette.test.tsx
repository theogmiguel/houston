// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'
import { pickOption, selectOptionLabels, selectOptionValues } from './test/selectHarness'
import { AUTO_TERMINAL_PALETTE, CHROME_THEMES, THEMES, THEME_LABELS } from './theme'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openAppearance(): Promise<void> {
  toggleSettings()
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings'
  )
  act(() => setSettingsNavForTests({ section: 'appearance' }))
}

describe('Settings → Appearance (settings-shape-a, 2026-08-26)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('keeps every one of the 24 palettes reachable, plus Auto', async () => {
    harness = await renderReadyApp()
    await openAppearance()
    const values = selectOptionValues(harness.container, 'palette-select')
    expect(values[0]).toBe(AUTO_TERMINAL_PALETTE)
    expect(values.slice(1)).toEqual([...THEMES])
    expect(selectOptionLabels(harness.container, 'palette-select').slice(1)).toEqual(
      THEMES.map((t) => THEME_LABELS[t])
    )
  })

  it('no longer renders a palette grid, a theme search box or mode tabs', async () => {
    harness = await renderReadyApp()
    await openAppearance()
    const { container } = harness
    expect(container.querySelector('[data-testid="theme-mock"]')).toBeNull()
    expect(container.querySelector('[aria-label="Search themes"]')).toBeNull()
    expect(container.querySelector('[role="tablist"][aria-label="Filter themes by mode"]')).toBeNull()
    expect(container.querySelector('[data-testid="active-theme-panel"]')).toBeNull()
  })

  it('offers exactly the two chrome themes, as tiles — no "Match system"', async () => {
    harness = await renderReadyApp()
    await openAppearance()
    const tiles = [...harness.container.querySelectorAll('[data-testid="chrome-theme-tile"]')]
    expect(tiles.map((t) => t.getAttribute('data-chrome-theme'))).toEqual([...CHROME_THEMES])
    expect(tiles.filter((t) => t.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })

  it('the chrome tiles and the palette select are independent axes', async () => {
    harness = await renderReadyApp()
    await openAppearance()
    const { container } = harness
    pickOption(container, 'palette-select', 'dracula')

    const paper = container.querySelector('[data-chrome-theme="paper"]') as HTMLButtonElement
    act(() => paper.click())

    expect(localStorage.getItem('tr-theme')).toBe('dracula')
    expect(localStorage.getItem('tr-chrome-theme')).toBe('paper')
  })
})
