// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

async function openWorkspacesSettings(_container: HTMLElement): Promise<void> {
  toggleSettings()
  await settleLazySurface(
    () => document.querySelector('[data-testid="settings-row"]') !== null,
    'Settings'
  )
  act(() => setSettingsNavForTests({ section: 'workspace-defaults' }))
}

function findRowToggle(container: HTMLElement, titleSubstring: string): HTMLButtonElement {
  const row = Array.from(container.querySelectorAll('[data-testid="settings-row"]')).find((r) =>
    r.textContent?.includes(titleSubstring)
  )
  if (!row) throw new Error(`"${titleSubstring}" row not found in the Workspaces section`)
  const toggle = row.querySelector('button[role="switch"]') as HTMLButtonElement | null
  if (!toggle) throw new Error(`Toggle button not found in "${titleSubstring}" row`)
  return toggle
}

describe('App Settings -> Workspaces -> "Open links in a browser pane" default (2026-08-18)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('defaults ON with no persisted key', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    await openWorkspacesSettings(container)

    const toggle = findRowToggle(container, 'Open links in a browser pane')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('tr-links-in-pane')).toBe('1')
  })

  it('honors a previously persisted "0" as off', async () => {
    localStorage.setItem('tr-links-in-pane', '0')
    harness = await renderReadyApp()
    const { container } = harness
    await openWorkspacesSettings(container)

    const toggle = findRowToggle(container, 'Open links in a browser pane')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('honors a previously persisted "1" as on', async () => {
    localStorage.setItem('tr-links-in-pane', '1')
    harness = await renderReadyApp()
    const { container } = harness
    await openWorkspacesSettings(container)

    const toggle = findRowToggle(container, 'Open links in a browser pane')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})
