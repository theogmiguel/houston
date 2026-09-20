// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import type { KeymapOverrides } from '../houston/client'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(): React.ComponentProps<typeof SettingsView> {
  return {
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
    keymapOverrides: {} as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

describe('SettingsView section id reconciliation (step 09, onto settingsSections.ts)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders Agent profiles content under the new `accounts` id', () => {
    act(() => setSettingsNavForTests({ section: 'accounts' }))
    act(() => root.render(<SettingsView {...baseProps()} />))
    expect(container.textContent).toContain('Accounts')
    expect(container.textContent).toContain('CLAUDE_CONFIG_DIR')
  })

  it('renders History content under the renamed `privacy` id, with the new label', () => {
    act(() => setSettingsNavForTests({ section: 'privacy' }))
    act(() => root.render(<SettingsView {...baseProps()} />))
    expect(container.textContent).toContain('Privacy & data')
    expect(container.textContent).toContain('Command history')
  })
})
