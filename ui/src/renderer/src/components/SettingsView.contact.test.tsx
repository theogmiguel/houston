// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('SettingsView About Contact button', () => {
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

  it('fires onContact when clicked in the About section', () => {
    const onContact = vi.fn()

    act(() => {
      root.render(<SettingsView {...baseProps()} onContact={onContact} />)
    })

    act(() => setSettingsNavForTests({ section: 'about' }))

    const buttons = Array.from(container.querySelectorAll('button'))
    const contactButton = buttons.find((b) => b.textContent === 'Contact')
    expect(contactButton).not.toBeUndefined()

    act(() => {
      contactButton!.click()
    })

    expect(onContact).toHaveBeenCalledTimes(1)
  })

  it('settings-72/-73: offers License, plus the release notes when an update is available', () => {
    const onOpenLicense = vi.fn()
    const onOpenExternal = vi.fn()
    act(() => {
      root.render(
        <SettingsView
          {...baseProps()}
          onOpenLicense={onOpenLicense}
          onOpenExternal={onOpenExternal}
          update={{
            policy: { check: true, channel: 'stable' },
            state: {
              kind: 'available',
              release: {
                version: '1.2.3',
                notes: 'A release body',
                notes_url: 'https://example.com/releases/1.2.3'
              },
              checked_at_ms: Date.now()
            }
          }}
        />
      )
    })
    act(() => setSettingsNavForTests({ section: 'about' }))

    const buttons = Array.from(container.querySelectorAll('button'))
    const notices = buttons.find((b) => b.textContent === 'View')
    const releaseNotes = buttons.find((b) => b.textContent === 'Release notes')
    expect(notices, 'License "View" button not found').not.toBeUndefined()
    expect(releaseNotes, 'Release notes button not found').not.toBeUndefined()

    act(() => notices!.click())
    expect(onOpenLicense).toHaveBeenCalledTimes(1)
    expect(onOpenExternal).not.toHaveBeenCalled()

    act(() => releaseNotes!.click())
    expect(onOpenExternal).toHaveBeenCalledWith('https://example.com/releases/1.2.3')
  })

  it('settings-74: drops the static "Session permissions" disclaimer (no control, no value)', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    act(() => setSettingsNavForTests({ section: 'about' }))
    expect(container.textContent).not.toContain('Session permissions')
  })

  it('settings-68/-74: does not duplicate Daemon logs — that row lives in Diagnostics now', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    act(() => setSettingsNavForTests({ section: 'about' }))
    expect(container.textContent).not.toContain('Daemon logs')
  })
})
