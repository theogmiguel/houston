import { useEffect, useRef } from 'react'
import type { ChromeTheme, TerminalPaletteChoice } from '../theme'
import type { KeymapOverrides } from '../houston/client'
import type { NotifyKinds } from '../notifyPrefs'
import type { NoticeSeverity } from './noticeSeverity'
import type { AgentKind } from '../houston/generated/AgentKind'
import type { AgentHookState } from '../houston/generated/AgentHookState'
import type { UpdatePolicy } from '../houston/generated/UpdatePolicy'
import type { UpdateState } from '../houston/generated/UpdateState'
import type { ServerMsg } from '../houston/generated/ServerMsg'
import type { CloudStt } from '../houston/generated/CloudStt'
import type { VoiceDevice } from '../houston/generated/VoiceDevice'
import type { VoiceModelState } from '../houston/generated/VoiceModelState'
import type { VoiceSettings } from '../houston/generated/VoiceSettings'
import type { McpServer } from '../houston/generated/McpServer'
import type { McpToolState } from '../houston/generated/McpToolState'
import type { McpSyncResult } from '../houston/generated/McpSyncResult'
import { useSettingsSection } from '../settingsNav'
import type { SettingsSectionId } from '../settingsSections'
import { consumeSettingsRowJump } from '../settingsRowJump'
import { PAGE_COLUMN_CLS, PAGE_COLUMN_WIDE_CLS } from './settingsPrimitives'
import { AboutSection } from './settings/AboutSection'
import { NotificationsSection } from './settings/NotificationsSection'
import { WorkspaceDefaultsSection } from './settings/WorkspaceDefaultsSection'
import { UsageTabSection } from './settings/UsageTabSection'
import { AppearanceSection } from './settings/AppearanceSection'
import { TerminalSection } from './settings/TerminalSection'
import { DiagnosticsSection } from './settings/DiagnosticsSection'
import { DaemonSection } from './settings/DaemonSection'
import { AccountsSection } from './settings/AccountsSection'
import { AgentStatusSection } from './settings/AgentStatusSection'
import { HeadlessRolesSection } from './settings/HeadlessRolesSection'
import { PrivacySection } from './settings/PrivacySection'
import { VoiceSection } from './settings/VoiceSection'
import { ShortcutsSection } from './settings/ShortcutsSection'
import { OrchestrationSection } from './settings/OrchestrationSection'
import type { UsageSummaryMsg } from './UsageSection'
import type { AgentProfile } from '../houston/generated/AgentProfile'
import type { AgentProfileActive } from '../houston/generated/AgentProfileActive'
import type { SessionPolicy } from '../houston/generated/SessionPolicy'
import type { OrchestrationCaps } from '../houston/generated/OrchestrationCaps'
import type { AcpAgentInfo } from '../houston/generated/AcpAgentInfo'
import type { HeadlessRoleKind } from '../houston/generated/HeadlessRoleKind'
import type { HeadlessRoleView } from '../houston/generated/HeadlessRoleView'
import { TERMINAL_LINE_HEIGHT_DEFAULT, TERMINAL_SCROLLBACK_DEFAULT } from '../usePreferences'
import { MATERIAL_CLS, materialAttrs } from './material'

export interface AgentProfileState {
  profiles: AgentProfile[]
  active: AgentProfileActive[]
}

export interface OrchestrationStateView {
  caps: OrchestrationCaps
  enabled: boolean
  acpAgents: AcpAgentInfo[]
}

export type HostInfo = Extract<ServerMsg, { type: 'host_info' }>

export interface McpStateView {
  source: McpServer[]
  sourcePath: string
  tools: McpToolState[]
  results: McpSyncResult[]
  checks: Extract<ServerMsg, { type: 'mcp_state' }>['checks']
}

interface Props {
  chromeTheme: ChromeTheme
  onChromeTheme: (t: ChromeTheme) => void
  theme: TerminalPaletteChoice
  onTheme: (t: TerminalPaletteChoice) => void
  shellIntegration: boolean
  onShellIntegration: (on: boolean) => void
  osc52: boolean
  onOsc52: (on: boolean) => void
  copyOnSelect: boolean
  onCopyOnSelect: (on: boolean) => void
  stripBoxGlyphs: boolean
  onStripBoxGlyphs: (on: boolean) => void
  fontSize: number
  onFontSize: (px: number) => void
  fontMin: number
  fontMax: number
  fontDefault: number
  fontFamilyId: string
  onFontFamilyId: (id: string) => void
  terminalLineHeight?: number
  onTerminalLineHeight?: (n: number) => void
  terminalCursorBlink?: boolean
  onTerminalCursorBlink?: (on: boolean) => void
  terminalScrollbackLines?: number
  onTerminalScrollbackLines?: (n: number) => void
  shiftEnterNewline: boolean
  onShiftEnterNewline: (on: boolean) => void
  openLinksInPane: boolean
  onOpenLinksInPane: (on: boolean) => void
  notifyKinds: NotifyKinds
  onNotifyKinds: (kinds: NotifyKinds) => void
  uiZoom: number
  onUiZoom: (z: number) => void
  zoomMin: number
  zoomMax: number
  zoomStep: number
  voiceSettings: VoiceSettings | null
  voiceCloudKeyPresent: boolean
  voiceKeyringError: string | null
  voiceModels: VoiceModelState[]
  voiceDevices: VoiceDevice[]
  onVoiceLevelMonitor: (enabled: boolean) => void
  onVoiceSettingsSet: (settings: VoiceSettings) => void
  onVoiceKeySet: (provider: CloudStt, key: string) => void
  onVoiceKeyClear: (provider: CloudStt) => void
  onVoiceDevicesRefresh: () => void
  onVoiceModelDownload: (modelId: string) => void
  onVoiceModelDelete: (modelId: string) => void
  agentProfiles: AgentProfileState | null
  onAgentProfileUpsert: (id: number | null, agent: AgentKind, name: string, configDir: string) => void
  onAgentProfileDelete: (id: number) => void
  onAgentProfileSetActive: (agent: AgentKind, id: number | null) => void
  orchestrationState: OrchestrationStateView | null
  onOpenAcpPane: (agent: AcpAgentInfo) => void
  historyWorkspace: string | null
  historyWorkspaceName: string | null
  historyCount: number | null
  onClearHistory: () => void
  historyIgnoreGlobs: string[] | null
  headlessWriter: HeadlessRoleView | null
  onHeadlessRoleSet: (role: HeadlessRoleKind, engine: AgentKind | null, model: string | null) => void
  onHistoryIgnoreGlobsSet: (globs: string[]) => void
  onOpenLogsFolder: () => void
  keymapOverrides: KeymapOverrides
  onKeymapOverrides: (overrides: KeymapOverrides) => void
  notifyEnabled: boolean
  onNotifyEnabled: (on: boolean) => void
  notifySound: boolean
  onNotifySound: (on: boolean) => void
  onNotifyPreview: (severity: NoticeSeverity) => void
  onContact: () => void
  onOpenLicense: () => void
  update: { policy: UpdatePolicy; state: UpdateState } | null
  onUpdateCheckNow: () => void
  onUpdatePolicySet: (policy: UpdatePolicy) => void
  onOpenExternal: (url: string) => void

  onRestoreBudgetSet: (n: number) => void
  sessionPolicy: SessionPolicy | null
  onSessionPolicy: (next: SessionPolicy) => void

  orchestrationEnabled: boolean
  onOrchestrationEnabled: (v: boolean) => void
  onOrchestrationCapsSet: (maxLiveChildren: number, maxSpawnDepth: number) => void
  onMailboxRetentionSet: (hours: number) => void

  hostInfo: HostInfo | null
  agentHooks: AgentHookState[] | null
  agentHooksCheckedAt?: number | null
  onAgentHooksSet: (provider: AgentKind, enabled: boolean) => void
  onAgentHooksRefresh: () => void
  onOpenHooks: () => void
  onRevealSessionDb: () => void
  usage: UsageSummaryMsg | null
  usageLoading: boolean
  usageError: string | null
  onUsageRequest: (sinceMs: number, untilMs: number, refreshPricing: boolean) => void
}

function SectionDispatch({
  section,
  chromeTheme,
  onChromeTheme,
  theme,
  onTheme,
  shellIntegration,
  onShellIntegration,
  osc52,
  onOsc52,
  copyOnSelect,
  onCopyOnSelect,
  stripBoxGlyphs,
  onStripBoxGlyphs,
  fontSize,
  onFontSize,
  fontMin,
  fontMax,
  fontDefault,
  fontFamilyId,
  onFontFamilyId,
  terminalLineHeight,
  onTerminalLineHeight,
  terminalCursorBlink,
  onTerminalCursorBlink,
  terminalScrollbackLines,
  onTerminalScrollbackLines,
  shiftEnterNewline,
  onShiftEnterNewline,
  openLinksInPane,
  onOpenLinksInPane,
  notifyKinds,
  onNotifyKinds,
  uiZoom,
  onUiZoom,
  voiceSettings,
  voiceCloudKeyPresent,
  voiceKeyringError,
  voiceModels,
  voiceDevices,
  onVoiceLevelMonitor,
  onVoiceSettingsSet,
  onVoiceKeySet,
  onVoiceKeyClear,
  onVoiceDevicesRefresh,
  onVoiceModelDownload,
  onVoiceModelDelete,
  agentProfiles,
  onAgentProfileUpsert,
  onAgentProfileDelete,
  onAgentProfileSetActive,
  orchestrationState,
  onOpenAcpPane,
  historyWorkspace,
  historyWorkspaceName,
  historyCount,
  onClearHistory,
  historyIgnoreGlobs,
  headlessWriter,
  onHeadlessRoleSet,
  onHistoryIgnoreGlobsSet,
  onOpenLogsFolder,
  keymapOverrides,
  onKeymapOverrides,
  notifyEnabled,
  onNotifyEnabled,
  notifySound,
  onNotifySound,
  onNotifyPreview,
  onContact,
  onOpenLicense,
  update,
  onUpdateCheckNow,
  onUpdatePolicySet,
  onOpenExternal,
  onRestoreBudgetSet,
  sessionPolicy,
  onSessionPolicy,
  orchestrationEnabled,
  onOrchestrationEnabled,
  onOrchestrationCapsSet,
  onMailboxRetentionSet,
  hostInfo,
  agentHooks,
  agentHooksCheckedAt = null,
  onAgentHooksSet,
  onAgentHooksRefresh,
  onOpenHooks,
  onRevealSessionDb,
  usage,
  usageLoading,
  usageError,
  onUsageRequest
}: SectionDispatchProps): React.JSX.Element {
  return (
    <>
        {section === 'appearance' && (
          <AppearanceSection
            chromeTheme={chromeTheme}
            onChromeTheme={onChromeTheme}
            theme={theme}
            onTheme={onTheme}
            uiZoom={uiZoom}
            onUiZoom={onUiZoom}
          />
        )}

        {section === 'terminal' && (
          <TerminalSection
            fontSize={fontSize}
            onFontSize={onFontSize}
            fontMin={fontMin}
            fontMax={fontMax}
            fontDefault={fontDefault}
            fontFamilyId={fontFamilyId}
            onFontFamilyId={onFontFamilyId}
            terminalLineHeight={terminalLineHeight}
            onTerminalLineHeight={onTerminalLineHeight}
            terminalCursorBlink={terminalCursorBlink}
            onTerminalCursorBlink={onTerminalCursorBlink}
            terminalScrollbackLines={terminalScrollbackLines}
            onTerminalScrollbackLines={onTerminalScrollbackLines}
            shellIntegration={shellIntegration}
            onShellIntegration={onShellIntegration}
            shiftEnterNewline={shiftEnterNewline}
            onShiftEnterNewline={onShiftEnterNewline}
            osc52={osc52}
            onOsc52={onOsc52}
            copyOnSelect={copyOnSelect}
            onCopyOnSelect={onCopyOnSelect}
            stripBoxGlyphs={stripBoxGlyphs}
            onStripBoxGlyphs={onStripBoxGlyphs}
          />
        )}

        {section === 'shortcuts' && (
          <ShortcutsSection keymapOverrides={keymapOverrides} onKeymapOverrides={onKeymapOverrides} />
        )}

        {section === 'voice' && (
          <VoiceSection
            voiceSettings={voiceSettings}
            voiceCloudKeyPresent={voiceCloudKeyPresent}
            voiceKeyringError={voiceKeyringError}
            voiceModels={voiceModels}
            voiceDevices={voiceDevices}
            onVoiceLevelMonitor={onVoiceLevelMonitor}
            onVoiceSettingsSet={onVoiceSettingsSet}
            onVoiceKeySet={onVoiceKeySet}
            onVoiceKeyClear={onVoiceKeyClear}
            onVoiceDevicesRefresh={onVoiceDevicesRefresh}
            onVoiceModelDownload={onVoiceModelDownload}
            onVoiceModelDelete={onVoiceModelDelete}
            keymapOverrides={keymapOverrides}
          />
        )}

        {section === 'agent-setup' && (
          <AgentStatusSection
            providers={agentHooks}
            onSet={onAgentHooksSet}
            onRefresh={onAgentHooksRefresh}
            checkedAt={agentHooksCheckedAt}
          />
        )}

        {section === 'accounts' && (
          <AccountsSection
            agentProfiles={agentProfiles}
            onAgentProfileUpsert={onAgentProfileUpsert}
            onAgentProfileDelete={onAgentProfileDelete}
            onAgentProfileSetActive={onAgentProfileSetActive}
          />
        )}

        {section === 'headless-roles' && (
          <HeadlessRolesSection
            headlessWriter={headlessWriter}
            onHeadlessRoleSet={onHeadlessRoleSet}
          />
        )}

        {section === 'orchestration' && (
          <OrchestrationSection
            orchestrationState={orchestrationState}
            orchestrationEnabled={orchestrationEnabled}
            onOrchestrationEnabled={onOrchestrationEnabled}
            onOrchestrationCapsSet={onOrchestrationCapsSet}
            onMailboxRetentionSet={onMailboxRetentionSet}
            hostInfo={hostInfo}
            onOpenAcpPane={onOpenAcpPane}
            historyWorkspace={historyWorkspace}
            historyWorkspaceName={historyWorkspaceName}
          />
        )}

        {section === 'privacy' && (
          <PrivacySection
            historyCount={historyCount}
            onClearHistory={onClearHistory}
            historyIgnoreGlobs={historyIgnoreGlobs}
            onHistoryIgnoreGlobsSet={onHistoryIgnoreGlobsSet}
            hostInfo={hostInfo}
            onRevealSessionDb={onRevealSessionDb}
          />
        )}

        {section === 'notifications' && (
          <NotificationsSection
            notifyKinds={notifyKinds}
            onNotifyKinds={onNotifyKinds}
            notifyEnabled={notifyEnabled}
            onNotifyEnabled={onNotifyEnabled}
            notifySound={notifySound}
            onNotifySound={onNotifySound}
            onNotifyPreview={onNotifyPreview}
          />
        )}

        {section === 'about' && (
          <AboutSection
            onContact={onContact}
            onOpenLicense={onOpenLicense}
            hostInfo={hostInfo}
            update={update}
            onUpdateCheckNow={onUpdateCheckNow}
            onUpdatePolicySet={onUpdatePolicySet}
            onOpenExternal={onOpenExternal}
          />
        )}

        {section === 'workspace-defaults' && (
          <WorkspaceDefaultsSection
            onRestoreBudgetSet={onRestoreBudgetSet}
            openLinksInPane={openLinksInPane}
            onOpenLinksInPane={onOpenLinksInPane}
            historyWorkspace={historyWorkspace}
            historyWorkspaceName={historyWorkspaceName}
            hostInfo={hostInfo}
            sessionPolicy={sessionPolicy}
            onSessionPolicy={onSessionPolicy}
          />
        )}

        {section === 'usage' && (
          <UsageTabSection
            usage={usage}
            usageLoading={usageLoading}
            usageError={usageError}
            onUsageRequest={onUsageRequest}
          />
        )}

        {section === 'diagnostics' && (
          <DiagnosticsSection
            hostInfo={hostInfo}
            agentHooks={agentHooks}
            onOpenHooks={onOpenHooks}
            onOpenLogsFolder={onOpenLogsFolder}
          />
        )}

        {section === 'daemon' && <DaemonSection />}
    </>
  )
}

interface ResolvedTuningProps {
  terminalLineHeight: number
  onTerminalLineHeight: (n: number) => void
  terminalCursorBlink: boolean
  onTerminalCursorBlink: (on: boolean) => void
  terminalScrollbackLines: number
  onTerminalScrollbackLines: (n: number) => void
}

type SectionDispatchProps = Omit<Props, keyof ResolvedTuningProps> &
  ResolvedTuningProps & { section: SettingsSectionId }

const NOOP = (): void => {}

export function SettingsView(props: Props): React.JSX.Element {
  const section = useSettingsSection()
  const terminalLineHeight = props.terminalLineHeight ?? TERMINAL_LINE_HEIGHT_DEFAULT
  const onTerminalLineHeight = props.onTerminalLineHeight ?? NOOP
  const terminalCursorBlink = props.terminalCursorBlink ?? true
  const onTerminalCursorBlink = props.onTerminalCursorBlink ?? NOOP
  const terminalScrollbackLines = props.terminalScrollbackLines ?? TERMINAL_SCROLLBACK_DEFAULT
  const onTerminalScrollbackLines = props.onTerminalScrollbackLines ?? NOOP

  const columnRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const title = consumeSettingsRowJump(section)
    if (!title) return
    const rows = columnRef.current?.querySelectorAll<HTMLElement>('[data-settings-row-name]') ?? []
    const row = Array.from(rows).find((r) => r.getAttribute('data-settings-row-name') === title)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.style.transition = 'background-color 300ms ease'
    row.style.backgroundColor = 'var(--accent-muted)'
    const fade = setTimeout(() => {
      row.style.backgroundColor = ''
    }, 900)
    return () => clearTimeout(fade)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])

  return (
    <div
      ref={columnRef}
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      {}
      <div
        className={`w-full min-w-0 mx-auto px-[var(--space-6)] pt-[var(--space-6)] pb-[60px] ${
          section === 'usage' || section === 'agent-setup'
            ? PAGE_COLUMN_WIDE_CLS
            : PAGE_COLUMN_CLS
        }`}
      >
        <SectionDispatch
          {...props}
          section={section}
          terminalLineHeight={terminalLineHeight}
          onTerminalLineHeight={onTerminalLineHeight}
          terminalCursorBlink={terminalCursorBlink}
          onTerminalCursorBlink={onTerminalCursorBlink}
          terminalScrollbackLines={terminalScrollbackLines}
          onTerminalScrollbackLines={onTerminalScrollbackLines}
        />
      </div>
    </div>
  )
}
