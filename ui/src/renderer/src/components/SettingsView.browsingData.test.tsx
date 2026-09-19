// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn(() => true) }))
vi.mock('../houston/host', () => ({ isTauri: () => isTauriMock() }))

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const { SettingsView } = await import('./SettingsView')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

let container: HTMLDivElement
let root: Root

const props = (): React.ComponentProps<typeof SettingsView> => ({
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
    usage: null,
    usageLoading: false,
    usageError: null,
    onUsageRequest: () => {},
    voiceSettings: null,
    voiceCloudKeyPresent: false,
    voiceKeyringError: null,
    voiceModels: [],
    voiceDevices: [],
    onVoiceSettingsSet: () => {},
    onVoiceKeySet: () => {},
    onVoiceKeyClear: () => {},
    onVoiceDevicesRefresh: () => {},
    onVoiceModelDownload: () => {},
    onVoiceModelDelete: () => {},
    onVoiceLevelMonitor: () => {},
    agentProfiles: null,
    onAgentProfileUpsert: () => {},
    onAgentProfileDelete: () => {},
    onAgentProfileSetActive: () => {},
  chromeTheme: 'graphite',
  onChromeTheme: () => {},
  theme: 'warm-espresso',
  fontSize: 14,
  onFontSize: () => {},
  fontMin: 8,
  fontMax: 24,
  fontDefault: 14,
  fontFamilyId: 'nerd',
  shiftEnterNewline: true,
  openLinksInPane: false,
  notifyKinds: NOTIFY_KINDS_DEFAULT,
  onNotifyKinds: () => {},
  onOpenLinksInPane: () => {},
  onShiftEnterNewline: () => {},
  onFontFamilyId: () => {},
  uiZoom: 1,
  onUiZoom: () => {},
  zoomMin: 0.5,
  zoomMax: 2,
  zoomStep: 0.1,
  onTheme: () => {},
  shellIntegration: true,
  onShellIntegration: () => {},
  osc52: true,
  onOsc52: () => {},
  copyOnSelect: false,
  onCopyOnSelect: () => {},
  stripBoxGlyphs: true,
  onStripBoxGlyphs: () => {},
  orchestrationState: null,
  onOpenAcpPane: () => {},
  historyWorkspace: null,
  historyWorkspaceName: null,
  historyCount: null,
  onClearHistory: () => {},
  historyIgnoreGlobs: null,
  headlessWriter: null,
  onHeadlessRoleSet: () => {},
  onHistoryIgnoreGlobsSet: () => {},
  onOpenLogsFolder: () => {},
    onContact: () => {},
    onOpenLicense: () => {},
    onRestoreBudgetSet: () => {},
    sessionPolicy: null,
    onSessionPolicy: () => {},
    orchestrationEnabled: true,
    onOrchestrationEnabled: () => {},
    onOrchestrationCapsSet: () => {},
    onMailboxRetentionSet: () => {},
    hostInfo: null,
    agentHooks: null,
    onOpenHooks: () => {},
    onAgentHooksSet: () => {},
    onAgentHooksRefresh: () => {},
    onRevealSessionDb: () => {},
  notifyEnabled: false,
  onNotifyEnabled: () => {},
  notifySound: true,
  onNotifySound: () => {},
  onNotifyPreview: () => {},
  keymapOverrides: { bindings: {}, shortcuts_enabled: true },
  onKeymapOverrides: () => {}
})

const render = (): void => {
  act(() => {
    root.render(<SettingsView {...props()} />)
  })
}

const openHistorySection = async (): Promise<void> => {
  await act(async () => setSettingsNavForTests({ section: 'privacy' }))
}

const clearButton = (): HTMLElement => {
  const btn = container.querySelector('[data-testid="settings-clear-browsing-data"]')
  if (!(btn instanceof HTMLElement)) throw new Error('no clear-browsing-data button rendered')
  return btn
}

beforeEach(() => {
  localStorage.clear()
  invokeMock.mockReset()
  isTauriMock.mockReturnValue(true)
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'browser_browsing_data_size') return 3_670_016
    return undefined
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('browser-store size and clearing (M5b)', () => {
  it('shows the store size, so the setting has a visible current value', async () => {
    render()
    await openHistorySection()
    expect(invokeMock).toHaveBeenCalledWith('browser_browsing_data_size')
    expect(container.textContent).toContain('3.5 MB')
  })

  it('needs a second click before it clears anything', async () => {
    render()
    await openHistorySection()
    const btn = clearButton()
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(invokeMock).not.toHaveBeenCalledWith('browser_clear_browsing_data')
    expect(btn.textContent).toContain('again')

    await act(async () => {
      clearButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_clear_browsing_data')
  })

  it("shows the host's refusal instead of swallowing it", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'browser_browsing_data_size') return 1024
      throw new Error('browser: 2 browser pane(s) are still live (["a", "b"])')
    })
    render()
    await openHistorySection()
    await act(async () => {
      clearButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      clearButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('still live')
  })

  it('asks the host for nothing under Electron', async () => {
    isTauriMock.mockReturnValue(false)
    render()
    await openHistorySection()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
