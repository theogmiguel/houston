// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openTerminalSettings(_container: HTMLElement): Promise<void> {
  toggleSettings()
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings'
  )
  act(() => setSettingsNavForTests({ section: 'terminal' }))
}

function findRowToggle(container: HTMLElement, titleSubstring: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll('[data-testid="settings-row"]')).find((r) =>
    r.textContent?.includes(titleSubstring)
  )
  if (!row) throw new Error(`"${titleSubstring}" row not found in Terminal section`)
  const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement | null
  if (!toggle) throw new Error(`Toggle button not found in "${titleSubstring}" row`)
  return toggle
}

describe('App Settings → Terminal → copy-on-select / strip-box-glyphs (P4 #20)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('"Copy on select" defaults off and toggling it persists tr-copy-on-select', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openTerminalSettings(container)

    const toggle = findRowToggle(container, 'Copy on select')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tr-copy-on-select')).toBe('0')

    act(() => toggle.click())

    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('tr-copy-on-select')).toBe('1')
  })

  it('"Copy the text, not the box" defaults on and toggling it persists tr-strip-box-glyphs', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openTerminalSettings(container)

    const toggle = findRowToggle(container, 'Copy the text, not the box')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('tr-strip-box-glyphs')).toBe('1')

    act(() => toggle.click())

    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem('tr-strip-box-glyphs')).toBe('0')
  })

  it('reads a previously persisted "off" value for strip-box-glyphs back into the row', async () => {
    localStorage.setItem('tr-strip-box-glyphs', '0')
    harness = await renderReadyApp()
    const { container } = harness
    await openTerminalSettings(container)

    const toggle = findRowToggle(container, 'Copy the text, not the box')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
