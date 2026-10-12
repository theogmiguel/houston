// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsView } from './SettingsView'
import { settingsSectionLabel, setSettingsNavForTests } from '../settingsNav'
import type { KeymapOverrides } from '../houston/client'
import type { AgentHookState } from '../houston/generated/AgentHookState'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

function baseProps(): React.ComponentProps<typeof SettingsView> {
  return {
    update: null,
    onUpdateCheckNow: () => {},
    onUpdatePolicySet: () => {},
    onOpenExternal: () => {},
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
    onRestoreResumeSet: () => {},
    onWorktreeCleanupSet: () => {},
    onWorktreeIdleRemovalDaysSet: () => {},
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
  }
}

describe('SettingsView destinations match the rebuilt Settings frame', () => {
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

  it('resolves accounts to CLIs and shows profiles without selecting a provider', () => {
    act(() => setSettingsNavForTests({ section: 'accounts' }))
    const agentHooks: AgentHookState[] = ['claude', 'codex'].map((provider) => ({
      provider: provider as AgentHookState['provider'],
      path: `~/.${provider}/settings.json`,
      scope: 'workspace' as const,
      enabled: false,
      installed: false,
      error: null,
      present: true,
      version: '1.0.0',
      trust: null
    }))
    act(() => root.render(<SettingsView {...baseProps()} agentHooks={agentHooks} agentProfiles={{ profiles: [{ id: 7, agent: 'claude', name: 'work', config_dir: '/home/dev/.claude-work' }], active: [] }} />))
    expect(settingsSectionLabel()).toBe('Agents / CLIs')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).toContain('Claude Code accounts')
    expect(container.textContent).toContain('/home/dev/.claude-work')
    expect(container.textContent).toContain('CLAUDE_CONFIG_DIR')
  })

  it('renders the Privacy & data destination content', () => {
    act(() => setSettingsNavForTests({ section: 'privacy' }))
    act(() => root.render(<SettingsView {...baseProps()} />))
    expect(container.textContent).toContain('What Houston keeps on this machine')
    expect(container.textContent).toContain('Command history')
  })
})
