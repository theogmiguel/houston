// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'
import { AUTO_TERMINAL_PALETTE, CHROME_THEMES, THEMES, THEME_LABELS } from './theme'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openSection(section: 'appearance' | 'terminal'): Promise<void> {
  toggleSettings()
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings'
  )
  act(() => setSettingsNavForTests({ section }))
}

describe('Settings → Terminal palette', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('keeps every one of the 24 palettes reachable, plus Auto', async () => {
    harness = await renderReadyApp()
    await openSection('terminal')
    const all = [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === `All ${THEMES.length} palettes`)!
    act(() => all.click())
    const tiles = [...harness.container.querySelectorAll<HTMLButtonElement>('[data-testid^="palette-tile-"]')]
    expect(tiles.map((tile) => tile.dataset.testid?.replace('palette-tile-', ''))).toEqual([
      AUTO_TERMINAL_PALETTE,
      ...THEMES
    ])
    expect(tiles.slice(1).map((tile) => tile.lastElementChild?.textContent?.trim())).toEqual(
      THEMES.map((theme) => THEME_LABELS[theme])
    )
  })

  it('no longer renders a palette grid, a theme search box or mode tabs', async () => {
    harness = await renderReadyApp()
    await openSection('appearance')
    const { container } = harness
    expect(container.querySelector('[data-testid="theme-mock"]')).toBeNull()
    expect(container.querySelector('[aria-label="Search themes"]')).toBeNull()
    expect(container.querySelector('[role="tablist"][aria-label="Filter themes by mode"]')).toBeNull()
    expect(container.querySelector('[data-testid="active-theme-panel"]')).toBeNull()
  })

  it('offers exactly the two chrome themes, as tiles — no "Match system"', async () => {
    harness = await renderReadyApp()
    await openSection('appearance')
    const tiles = [...harness.container.querySelectorAll('[data-testid="chrome-theme-tile"]')]
    expect(tiles.map((t) => t.getAttribute('data-chrome-theme'))).toEqual([...CHROME_THEMES])
    expect(tiles.filter((t) => t.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  })

  it('the chrome tiles and terminal palette tiles are independent axes', async () => {
    harness = await renderReadyApp()
    await openSection('terminal')
    const { container } = harness
    const dracula = container.querySelector('[data-testid="palette-tile-dracula"]') as HTMLButtonElement
    act(() => dracula.click())

    act(() => setSettingsNavForTests({ section: 'appearance' }))
    const paper = container.querySelector('[data-chrome-theme="paper"]') as HTMLButtonElement
    act(() => paper.click())

    expect(localStorage.getItem('tr-theme')).toBe('dracula')
    expect(localStorage.getItem('tr-chrome-theme')).toBe('paper')
    expect(dracula.getAttribute('aria-pressed')).toBe('true')
  })
})
