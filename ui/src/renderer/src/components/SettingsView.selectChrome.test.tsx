// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { setSettingsNavForTests } from '../settingsNav'
import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import { SELECT_CLS } from './selectChrome'
import { selectTrigger } from '../test/selectHarness'
import type { KeymapOverrides } from '../houston/client'
import type { VoiceSettings } from '../houston/generated/VoiceSettings'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function voiceSettingsFixture(): VoiceSettings {
  return {
    enabled: true,
    engine: { kind: 'local', model_id: 'ggml-small' },
    output_mode: 'original',
    input_language: null,
    capture_mode: 'hold',
    input_device: null,
    insert_mode: 'direct',
    vocabulary: '',
    agent_preamble: true,
    mic_policy: 'persistent',
    rms_floor: 0.01
  }
}

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
    voiceSettings: voiceSettingsFixture(),
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
    keymapOverrides: { bindings: {}, shortcuts_enabled: true } as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

function openSection(id: 'terminal' | 'voice' | 'appearance' | 'headless-roles'): void {
  act(() => setSettingsNavForTests({ section: id }))
}

describe('SettingsView — every picker composes SELECT_CLS (dropdown-01)', () => {
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

  it('Terminal → Font family picker is on SELECT_CLS', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection('terminal')
    expect(selectTrigger(container, 'settings-font-family').className).toContain(SELECT_CLS)
  })

  it('Voice section pickers are all on SELECT_CLS, width preserved', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    openSection('voice')
    const testIds = [
      'settings-voice-engine',
      'settings-voice-output',
      'settings-voice-capture-mode',
      'settings-voice-mic-policy',
      'settings-voice-language',
      'settings-voice-insert-mode'
    ]
    for (const id of testIds) {
      const cls = selectTrigger(container, id).className
      expect(cls, `${id} lost SELECT_CLS`).toContain(SELECT_CLS)
      expect(cls, `${id} lost its width`).toContain('w-[200px]')
    }
  })

  it('no native <select> survives anywhere in SettingsView', () => {
    act(() => {
      root.render(<SettingsView {...baseProps()} />)
    })
    for (const id of ['appearance', 'terminal', 'voice', 'headless-roles'] as const) {
      act(() => setSettingsNavForTests({ section: id }))
      expect(container.querySelectorAll('select'), `native <select> in ${id}`).toHaveLength(0)
    }
  })
})
