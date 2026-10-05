// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'
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

function openSection(section: 'appearance' | 'terminal'): void {
  act(() => setSettingsNavForTests({ section }))
}

function paletteTile(container: HTMLElement, theme: string): HTMLButtonElement {
  const tile = container.querySelector(`[data-testid="palette-tile-${theme}"]`)
  if (!(tile instanceof HTMLButtonElement)) throw new Error(`no palette tile ${theme}`)
  return tile
}

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
    openSection('terminal')

    const autoTile = paletteTile(container, 'auto')
    expect(autoTile.getAttribute('aria-pressed')).toBe('true')
    expect(autoTile.textContent).toContain(`Auto · ${THEME_LABELS[DEFAULT_TERMINAL_PALETTE_FOR_CHROME[DEFAULT_CHROME_THEME]]}`)
    expect(autoTile.textContent).toContain('follows Graphite')
  })

  it('re-resolves live when the chrome theme switches, and stays selected', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openSection('terminal')

    openSection('appearance')
    act(() => chromeTile(container, 'paper').click())
    openSection('terminal')

    const autoTile = paletteTile(container, 'auto')
    expect(autoTile.getAttribute('aria-pressed')).toBe('true')
    expect(autoTile.textContent).toContain(`Auto · ${THEME_LABELS[DEFAULT_TERMINAL_PALETTE_FOR_CHROME.paper]}`)
    expect(autoTile.textContent).toContain('follows Paper')
  })

  it('picking a concrete palette pins it, no longer following chrome switches', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openSection('terminal')

    act(() => paletteTile(container, 'dracula').click())

    expect(paletteTile(container, 'dracula').getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('tr-theme')).toBe('dracula')

    openSection('appearance')
    act(() => chromeTile(container, 'paper').click())
    openSection('terminal')

    expect(localStorage.getItem('tr-theme')).toBe('dracula')
    expect(paletteTile(container, 'dracula').getAttribute('aria-pressed')).toBe('true')
  })

  it('the chip strip fingerprints the palette actually in force', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openSettings()
    openSection('terminal')

    const chips = paletteTile(container, 'auto').querySelectorAll('i')
    expect(chips).toHaveLength(6)
    expect([...chips].every((c) => (c as HTMLElement).style.background !== '')).toBe(true)
  })
})
