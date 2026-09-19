// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type AppHarness, renderReadyApp, resetHarness, settleLazySurface, toggleSettings } from './test/appTestHarness'
import { setSettingsNavForTests } from './settingsNav'

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('App Settings → Diagnostics → open logs folder (P4 #19)', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('clicking "Open folder" on the Daemon logs row resolves the logs dir via main, then opens it', async () => {
    harness = await renderReadyApp()
    const { container } = harness

    toggleSettings()
    await settleLazySurface(
      () => document.querySelector('[data-testid="settings-row"]') !== null,
      'Settings'
    )
    act(() => setSettingsNavForTests({ section: 'diagnostics' }))

    const logsRow = Array.from(container.querySelectorAll('[data-testid="settings-row"]')).find((r) =>
      r.textContent?.includes('Daemon logs')
    )
    if (!logsRow) throw new Error('"Daemon logs" row not found in Diagnostics section')
    const openFolderButton = Array.from(logsRow.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Open folder')
    ) as HTMLButtonElement | undefined
    if (!openFolderButton) throw new Error('"Open folder" button not found in Daemon logs row')

    const getLogsDir = window.houston.getLogsDir as unknown as ReturnType<typeof vi.fn>
    const openPath = window.houston.openPath as unknown as ReturnType<typeof vi.fn>
    getLogsDir.mockResolvedValue('/home/test/.houston-dev/logs')
    openPath.mockClear()

    await act(async () => {
      openFolderButton.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getLogsDir).toHaveBeenCalled()
    expect(openPath).toHaveBeenCalledWith('/home/test/.houston-dev/logs')
  })
})
