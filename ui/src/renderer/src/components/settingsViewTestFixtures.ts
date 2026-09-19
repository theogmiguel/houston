import { NOTIFY_KINDS_DEFAULT } from '../notifyPrefs'
import type { KeymapOverrides } from '../houston/client'
import type { HeadlessRoleView } from '../houston/generated/HeadlessRoleView'
import type { HostInfo, SettingsView } from './SettingsView'

;(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test'

export function baseSettingsViewProps(): React.ComponentProps<typeof SettingsView> {
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
    keymapOverrides: {} as KeymapOverrides,
    onKeymapOverrides: () => {},
    notifyEnabled: false,
    onNotifyEnabled: () => {},
    notifySound: true,
    onNotifySound: () => {},
    onNotifyPreview: () => {}
  }
}

export function headlessRoleViewFixture(
  overrides: Partial<HeadlessRoleView> = {}
): HeadlessRoleView {
  return {
    role: 'writer',
    engine: 'claude',
    engine_is_default: true,
    model: null,
    model_is_default: true,
    engines: [
      {
        engine: 'claude',
        enabled: true,
        reason: null,
        verified: true,
        models: ['haiku', 'sonnet', 'opus']
      },
      { engine: 'codex', enabled: true, reason: null, verified: false, models: [] },
      {
        engine: 'antigravity',
        enabled: false,
        reason:
          "Panes only. Google's terms on third-party access are unclear, and a strike can reach your Google account.",
        verified: false,
        models: []
      },
      { engine: 'opencode', enabled: true, reason: null, verified: false, models: [] },
      {
        engine: 'cursor',
        enabled: false,
        reason: 'Panes only. No verified headless stream.',
        verified: false,
        models: []
      },
      {
        engine: 'grok',
        enabled: true,
        reason: null,
        verified: false,
        models: ['grok-4.5', 'grok-composer-2.5-fast']
      }
    ],
    ...overrides
  }
}

export function hostInfoFixture(overrides: Partial<HostInfo> = {}): HostInfo {
  return {
    type: 'host_info',
    channel: 'dev',
    state_dir: '/home/t/.houston-dev',
    pid: 4242,
    port: 43153,
    protocol_version: 70,
    app_version: '0.0.0-test',
    build_commit: 'abc1234',
    uptime_ms: 4 * 3_600_000 + 12 * 60_000,
    live_sessions: 7,
    restore_budget: 8,
    restore_deferred: 0,
    orchestration_depth_in_use: 2,
    orchestration_max_depth: 4,
    mailbox_files_on_disk: 31,
    mailbox_retention_hours: 24,
    command_history_ignore_glob_count: 6,
    session_db_bytes: 3_984_588,
    ...overrides
  }
}

export function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
