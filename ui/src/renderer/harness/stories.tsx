import React from 'react'
import { NewSessionComposer } from '../src/components/NewSessionComposer'
import { LaunchGridPreview } from '../src/components/ui/LaunchGridPreview'
import type { SessionSlot } from '../src/components/sessionPresets'
import { leaf, type LayoutNode } from '../src/layout/tree'

function NewSession(): React.JSX.Element {
  return (
    <NewSessionComposer
      workspaceName="acme"
      workspacePath="~/Desktop/acme"
      gridName="Improve Orchestration"
      onLaunch={() => {}}
      onCancel={() => {}}
    />
  )
}

function NewSessionClicked({ selector, focusSelector }: { selector: string; focusSelector?: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(selector)?.click()
    if (focusSelector) ref.current?.querySelector<HTMLButtonElement>(focusSelector)?.focus()
  }, [selector])
  return (
    <div ref={ref} style={{ display: 'flex', height: '100%' }}>
      <NewSession />
    </div>
  )
}

function DockedLaunchHoverStory(): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      ref.current?.querySelector<HTMLButtonElement>('[data-preset="swarm"]')?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true })
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  return <DockedLaunchStory ref={ref} />
}

const launchStoryTree: LayoutNode = {
  kind: 'split', dir: 'row', children: [leaf(1), leaf(2)], weights: [1, 1]
}
const launchStorySessions = new Map<number, SessionInfo>([
  [1, { id: 1, agent: 'claude' } as SessionInfo],
  [2, { id: 2, agent: 'codex' } as SessionInfo]
])

const DockedLaunchStory = React.forwardRef<HTMLDivElement>(function DockedLaunchStory(_, ref): React.JSX.Element {
  const [preview, setPreview] = React.useState<{ slots: SessionSlot[]; target: 'this-grid' | 'new-grid' } | null>(null)
  const updatePreview = React.useCallback((slots: SessionSlot[], target: 'this-grid' | 'new-grid'): void => {
    setPreview({ slots, target })
  }, [])
  return (
    <div ref={ref} className="flex h-full min-w-0 bg-[var(--content-bg)]">
      <div className="relative min-w-0 flex-1" aria-label="Current grid">
        <div className="absolute inset-0 grid grid-cols-2 gap-[var(--pane-gutter)] p-[var(--pane-gutter)]">
        {['Session · Claude Code', 'Session · Codex'].map((name) => (
            <div key={name} className="flex items-center justify-center rounded-[var(--tr-radius-md)] border border-[var(--border)] bg-[var(--card-bg)] text-[var(--text-muted)]">{name}</div>
        ))}
        </div>
        {preview && <LaunchGridPreview tree={launchStoryTree} slots={preview.slots} target={preview.target} sessions={launchStorySessions} />}
      </div>
      <NewSessionComposer
        workspaceName="acme"
        workspacePath="~/Desktop/acme"
        gridName="Improve Orchestration"
        onPreviewChange={updatePreview}
        onLaunch={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
})
import { Sidebar } from '../src/components/Sidebar'
import type { SessionInfo, Workspace } from '../src/houston/client'
import { AppearancePickerStory, SettingsAbout, SettingsAgentSetup, SettingsAgentStatusEmpty, SettingsAgentStatusLoading, SettingsAppearance, SettingsAppearanceCustom, SettingsDetailStory, SettingsDiagnostics, SettingsDictation, SettingsNotifications, SettingsOrchestration, SettingsOrchestrationEmptyRoster, SettingsOrchestrationLoading, SettingsOrchestrationNoWorkspace, SettingsPrivacy, SettingsSearchStory, SettingsShortcuts, SettingsShortcutsArmed, SettingsShortcutsConflict, SettingsTerminal, SettingsWorkspaces } from './settingsStories'
import {
  NoticesError,
  NoticesExiting,
  NoticesPaneCorner,
  NoticesOrchestration,
  NoticesResting,
  NoticesStacked
} from './noticeStories'

import {
  NavHooks,
  NavMcp,
  NavMcpDetail,
  NavMcpForm,
  NavRoutineEditor,
  NavRoutines,
  NavRoutinesEmpty,
  NavSkills,
  HarnessPageStory,
  NavRoutineEditorClock,
  NavRoutineEditorInterval,
  NavRoutineRows,
  NavRoutineRunOutcomes,
  NavListDetailStates,
  NavChromeStates,
  HarnessReportStates,
  HarnessHistoryStory,
  HarnessReportLoadingStory,
  HarnessHistoryEmptyStory,
  HarnessFindingsDismissedStory
} from './navStories'
import { B5bHandoffStatesStory, B5bPaneHandoffSelectedStory, B5bQuestionStatesStory, B5bDelegationPanelsStory } from './b5bStories'
import { PaneLifecycleStory, TasksDetailStory, TasksListStory, TasksQueueStory, TasksRosterStory, TasksSettingsReviewRefusalStory, TasksSettingsStory, TasksOverviewRosterStory } from './tasksStories'
import { RenameTitleStory } from './renameTitleStories'
import { TasksPageStory } from './tasksPageStory'
import { UsagePageStory } from './usagePageStory'
import { AddPanePopover } from '../src/components/AddPanePopover'
import { WorkspaceEmpty } from '../src/components/WorkspaceEmpty'

const STORY_ACTIONS = [{ id: 'test', name: 'test', command: 'bun run test', shortcut: null }, { id: 'dev', name: 'dev', command: 'bun run dev', shortcut: null }]
import { UiPrimitivesStory } from './uiStories'
import { AddPaneDisabled, AddPaneProfiles, AttachmentChips, AttachmentPreviews, ComposerControlsOpen, ComposerControlsOverflow, ComposerControlsStates, NewSessionTask, NewSessionWithRoutes, ReconnectBannerStory } from './composerStories'
import { FilesEmptyGraphite, FilesNarrowGraphite, FilesPaneGraphite, FilesRenameGraphite, FilesRootErrorGraphite, FilesSplitGraphite, FilesSplitPaper, FilesTabMenuGraphite, FilesTreeMenuGraphite } from './filesStories'
import { B9EditorStory, B9LayoutStory, B9MarkdownStory, B9OpenInStory, B9PreviewStory, B9VoiceListeningStory, B9VoiceTranscribingStory, B9WindowStory } from './b9Stories'
import { PaletteGraphiteStory, PalettePaperStory } from './paletteStories'
import { InspectorChangesGraphite, InspectorChangesPaper, InspectorChildrenGraphite, InspectorChildrenPaper, InspectorFilesGraphite, InspectorOverviewStory, InspectorPrGraphite, InspectorPrPaper } from './inspectorStories'
import {
  LegacyBranchesStory,
  LegacyBranchesPopulatedStory,
  LegacyBrowserActStory,
  LegacyCheckpointsStory,
  LegacyCheckpointsPopulatedStory,
  LegacyConfirmStory,
  LegacyDelegationBadgeStory,
  LegacyDelegationPanelStory,
  LegacyGitShellStory,
  LegacyChangesIdleStory,
  LegacyTimelineStatesStory,
  LegacyHandoffStory,
  LegacyHostKeyStory,
  LegacyPaneHandoffStory,
  LegacyQuestionStory,
  LegacySaveDiscardStory,
  LegacyShortcutStory,
  LegacySshStory,
  LegacyTagsStory,
  LegacyUpdateStory
} from './dialogStories'
import { GridRailRow } from '../src/components/ui/GridRailRow'
import { FirstRunHooksStepSpecimen } from '../src/components/ui/FirstRunHooksStep'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'
import { SlackConnectionsStory } from './integrationStories'
import { BootFailureStory, BootLoadingStory, FirstRunOrchestrationStory, FirstRunWorkspaceStory, HostKeyChangedStory, ShortcutsOffStory, SshAdvancedStory, UpdateEmptyStory, UpdateInstallingStory, UpdateKeepStory, UpdateRunningStory, UpdateStopStory, UpdateUnsupportedStory } from './modalStates'
import { PrActionsCapture, PrBrowseCapture, PrBrowseStatesCapture, PrCommentEditCapture, PrDiscussionCapture, PrEmptyCapture, PrFilesCapture, PrFilesStatesCapture, PrPickerCapture, PrReviewCapture, ReviewProviderCapture, ReviewProviderSelectedCapture } from './prCloseoutStories'
import { PaneEndedStory, PaneMenuStory, PaneMiscStory, PaneTerminalStatesStory, TagEditorStory, TagsFormsStory } from './paneChromeStories'

const noop = (): void => {}

function RailGridRowStory({ theme, width }: { theme: 'graphite' | 'paper'; width: number }): React.JSX.Element {
  React.useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const sessions = [
    { id: 11, agent: 'claude', project_dir: '/work/houston', cwd: '/work/houston', checkout_root: '/work/houston', state: 'running', status: 'working', status_since_ms: Date.now() - 14 * 60_000, title: 'Rail implementation', codename: 'Rail', hidden: false, live_children: 1, children_waiting: 0, context: { used_percent: 63 }, task: { key: 'HOU-411' }, spawned_by: null },
    { id: 12, agent: 'codex', project_dir: '/work/houston', cwd: '/work/houston-wt', worktree: { path: '/work/houston-wt', branch: 'ui/p4-rail' }, state: 'running', status: 'needs-input', status_since_ms: Date.now() - 4 * 60_000, title: 'Review rail states', codename: 'Review', hidden: false, live_children: 0, children_waiting: 0, context: { used_percent: 91 }, task: { key: 'HOU-412' }, spawned_by: 11 }
  ] as unknown as SessionInfo[]
  const store = React.useMemo(() => createSessionsStore(new Map(sessions.map((session) => [session.id, session]))), [])
  return <div style={{ width, height: '100%', padding: 18, background: 'var(--background)' }}>
    <SessionsStoreContext.Provider value={store}>
      <GridRailRow name="Rail implementation" selected paneIds={[11, 12]} tags={[{ id: 1, name: 'Bug', color: '#f472b6' }, { id: 2, name: 'Teste', color: '#f59e0b' }]} fallbackSessions={sessions} branches={new Map([[11, 'ui/p4-rail'], [12, 'ui/p4-rail']])} diffByDir={new Map([['/work/houston', { added: 142, deleted: 39, ahead: 2, behind: 0, changedFiles: 5 }], ['/work/houston-wt', { added: 24, deleted: 8, ahead: 0, behind: 1, changedFiles: 2 }]])} prByDir={new Map([['/work/houston', { gh: 'ready', pr: { number: 411, url: 'https://github.com/example/houston/pull/411', state: 'OPEN', review_decision: 'REVIEW_REQUIRED', checks: 'running' } }]])} width={width} jumpNumber={1} onSelect={noop} onOpenInspector={noop} onOpenExternal={noop} />
    </SessionsStoreContext.Provider>
  </div>
}

function RailWorkspacesMulti(): React.JSX.Element {
  const ws = (path: string, name: string): Workspace => ({ path, name }) as Workspace
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <Sidebar
        workspaces={[
          ws('/home/dev/code/acme-core', 'acme-core'),
          ws('/home/dev/code/acme-api', 'acme-api'),
          ws('/home/dev/code/bridgespace-tauri', 'bridgespace-tauri'),
          ws('/home/dev/code/acme-ui', 'acme-ui'),
          ws('/home/dev/code/acme-one-swift', 'acme-one-swift'),
          ws('/home/dev/code/houston', 'houston')
        ]}
        sessions={[] as SessionInfo[]}
        selected="/home/dev/code/acme-one-swift"
        selectedGridId="grok-build"
        gridsByWorkspace={{
          '/home/dev/code/acme-core': [
            { id: 'work-in', name: 'Work in', count: 5, state: 'working' },
            { id: 'disc', name: 'Disc utilization space check', count: 3, state: 'working' },
            { id: 'bomb', name: 'Bomb calorimeter design', count: 4, state: 'working' }
          ],
          '/home/dev/code/acme-one-swift': [
            { id: 'grok-build', name: 'Grok Build', count: 3, state: 'working' },
            { id: 'swift-ui', name: 'SwiftUI pass', count: 1, state: 'idle' },
            { id: 'notarize', name: 'Notarize', state: 'needs-input' }
          ]
        }}
        customColors={{}}
        colorIndexByPath={{}}
        renaming={null}
        onSelect={noop}
        onAddWorkspace={noop}
        onRemoveWorkspace={noop}
        onRenameStart={noop}
        onRenameSubmit={noop}
        onRenameCancel={noop}
        onChangeColor={noop}
        onReorderWorkspace={noop}
        pinnedWorkspaces={new Set()}
        onTogglePinWorkspace={noop}
        onSshConnect={noop}
        chromeTheme="graphite"
        onToggleChromeTheme={noop}
        onSelectGrid={noop}
        onAddGrid={noop}
        onRenameGrid={noop}
        onRemoveGrid={noop}
        onOpenSettings={noop}
      />
    </div>
  )
}

export const STORIES: Record<string, () => React.JSX.Element> = {
  'new-session/default': () => <NewSession />,
  'shell/add-pane-menu': () => <AddPanePopover right={24} y={24} hasWorkspace keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onClose={() => {}} onNewTerminal={() => {}} onNewBrowser={() => {}} onSpawnAgent={() => {}} onSplitDown={() => {}} onNewGrid={() => {}} agentProfiles={null} workspaceActions={STORY_ACTIONS} />,
  'shell/workspace-empty': () => <WorkspaceEmpty onNewSession={() => {}} onTerminal={() => {}} onBrowser={() => {}} actions={STORY_ACTIONS} />,
  'launch/docked': () => <DockedLaunchStory />,
  'launch/docked-preset-hover': () => <DockedLaunchHoverStory />,
  'new-session/swarm': () => <NewSessionClicked selector='[data-preset="swarm"]' focusSelector='[data-preset="pair"]' />,
  'new-session/terminal': () => <NewSessionClicked selector='[data-agent="shell"]' />,
  'harness/smoke': () => (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        color: 'var(--text-primary)',
        font: '500 13px var(--font-sans, sans-serif)'
      }}
    >
      harness ok — theme tokens, fonts and Tailwind layers loaded
    </div>
  ),
  'legacy/confirm': () => <LegacyConfirmStory />,
  'legacy/save-discard': () => <LegacySaveDiscardStory />,
  'legacy/shortcuts': () => <LegacyShortcutStory />,
  'legacy/host-key': () => <LegacyHostKeyStory />,
  'legacy/ssh': () => <LegacySshStory />,
  'legacy/handoff': () => <LegacyHandoffStory />,
  'legacy/pane-handoff': () => <LegacyPaneHandoffStory />,
  'legacy/tags': () => <LegacyTagsStory />,
  'legacy/question': () => <LegacyQuestionStory />,
  'legacy/git-shell': () => <LegacyGitShellStory />,
  'legacy/changes-idle': () => <LegacyChangesIdleStory />,
  'legacy/timeline-states': () => <LegacyTimelineStatesStory />,
  'legacy/overview': () => <InspectorOverviewStory />,
  'legacy/branches': () => <LegacyBranchesStory />,
  'legacy/branches-populated': () => <LegacyBranchesPopulatedStory />,
  'legacy/checkpoints': () => <LegacyCheckpointsStory />,
  'legacy/checkpoints-populated': () => <LegacyCheckpointsPopulatedStory />,
  'legacy/delegation-badge': () => <LegacyDelegationBadgeStory />,
  'legacy/delegation-panel': () => <LegacyDelegationPanelStory />,
  'legacy/update': () => <LegacyUpdateStory />,
  'legacy/update-keep': () => <UpdateKeepStory />,
  'legacy/update-stop': () => <UpdateStopStory />,
  'legacy/update-unsupported': () => <UpdateUnsupportedStory />,
  'legacy/update-empty': () => <UpdateEmptyStory />,
  'legacy/update-running': () => <UpdateRunningStory />,
  'legacy/update-installing': () => <UpdateInstallingStory />,
  'legacy/host-key-changed': () => <HostKeyChangedStory />,
  'legacy/ssh-advanced': () => <SshAdvancedStory />,
  'legacy/shortcuts-off': () => <ShortcutsOffStory />,
  'firstrun/orchestration': () => <FirstRunOrchestrationStory />,
  'firstrun/workspace': () => <FirstRunWorkspaceStory />,
  'boot/loading': () => <BootLoadingStory />,
  'boot/failure': () => <BootFailureStory />,
  'legacy/browser-act': () => <LegacyBrowserActStory />,
  'b5b/handoff-states': () => <B5bHandoffStatesStory />,
  'b5b/pane-handoff-selected': () => <B5bPaneHandoffSelectedStory />,
  'b5b/question-states': () => <B5bQuestionStatesStory />,
  'b5b/delegation-panels': () => <B5bDelegationPanelsStory />,
  'ui-primitives': () => <UiPrimitivesStory />,
  'b9/markdown-preview': () => <B9MarkdownStory />,
  'b9/editor-surface-menu': () => <B9EditorStory />,
  'b9/editor-preview-states': () => <B9PreviewStory />,
  'b9/dictation-listening': () => <B9VoiceListeningStory />,
  'b9/dictation-transcribing': () => <B9VoiceTranscribingStory />,
  'b9/window-controls-resize': () => <B9WindowStory />,
  'b9/layout-drop-slots-splitter': () => <B9LayoutStory />,
  'b9/open-in-submenu': () => <B9OpenInStory />,
  'connections/slack-connected': () => <SlackConnectionsStory state="connected" />,
  'connections/slack-reconnecting': () => <SlackConnectionsStory state="reconnecting" />,
  'connections/slack-off': () => <SlackConnectionsStory state="off" />,
  'connections/slack-configure': () => <SlackConnectionsStory state="connected" openDrawer />,
  'firstrun/hooks': () => (
    <div className="flex h-full bg-[var(--content-bg)] text-[var(--text-primary)]">
      <aside className="flex w-[240px] flex-none flex-col border-r border-[var(--border)] bg-[var(--rail-bg)]">
        <div className="px-[var(--space-3)] py-[var(--space-2)] [font-size:var(--tr-text-ui-size)] font-semibold">Houston</div>
        <div className="mx-[var(--space-2)] rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-2)] py-[var(--space-1)] [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">Search</div>
        {['Tasks', 'Skills', 'Routines', 'Harness', 'Connections', 'Usage'].map((item) => <div key={item} className="flex min-h-[var(--h-ctl-mini)] items-center px-[14px] [font-size:var(--tr-text-label-size)] text-[var(--text-secondary)]">{item}</div>)}
        <div className="px-[14px] py-[var(--space-2)] [font-size:var(--tr-text-ui-size)] font-semibold">Workspaces</div>
        <div className="flex-1 px-[38px] py-[var(--space-2)] [font-size:var(--tr-text-small-size)] text-[var(--text-faint)]">No sessions yet</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="h-[30px] flex-none border-b border-[var(--border)]" />
        <FirstRunHooksStepSpecimen />
      </div>
    </div>
  ),
  'palette/graphite': () => <PaletteGraphiteStory />,
  'palette/paper': () => <PalettePaperStory />,
  'harness/page': () => <HarnessPageStory />,
  'harness/first-run': () => <HarnessPageStory firstRun />,
  'harness/no-reviews': () => <HarnessPageStory noReviews />,
  'rail/workspaces-multi': () => <RailWorkspacesMulti />,
  'rail/grid-row-graphite-200': () => <RailGridRowStory theme="graphite" width={200} />,
  'rail/grid-row-graphite-240': () => <RailGridRowStory theme="graphite" width={240} />,
  'rail/grid-row-graphite-420': () => <RailGridRowStory theme="graphite" width={420} />,
  'rail/grid-row-paper-200': () => <RailGridRowStory theme="paper" width={200} />,
  'rail/grid-row-paper-240': () => <RailGridRowStory theme="paper" width={240} />,
  'rail/grid-row-paper-420': () => <RailGridRowStory theme="paper" width={420} />,
  'settings/agent-setup': () => <SettingsAgentSetup />,
  'settings/agents': () => <SettingsAgentSetup />,
  'settings/agents-loading': () => <SettingsAgentStatusLoading />,
  'settings/agents-empty': () => <SettingsAgentStatusEmpty />,
  'settings/appearance': () => <SettingsAppearance />,
  'settings/appearance-custom': () => <SettingsAppearanceCustom />,
  'settings/detail': () => <SettingsDetailStory />,
  'settings/detail-error': () => <SettingsDetailStory state="error" />,
  'settings/detail-loading': () => <SettingsDetailStory state="loading" />,
  'settings/detail-empty': () => <SettingsDetailStory state="empty" />,
  'settings/appearance-picker': () => <AppearancePickerStory />,
  'settings/appearance-picker-empty': () => <AppearancePickerStory empty />,
  'settings/search': () => <SettingsSearchStory />,
  'settings/terminal': () => <SettingsTerminal />,
  'settings/notifications': () => <SettingsNotifications />,
  'settings/shortcuts': () => <SettingsShortcuts />,
  'settings/shortcuts-armed': () => <SettingsShortcutsArmed />,
  'settings/shortcuts-conflict': () => <SettingsShortcutsConflict />,
  'settings/diagnostics': () => <SettingsDiagnostics />,
  'settings/daemon': () => <SettingsDiagnostics />,
  'settings/orchestration': () => <SettingsOrchestration />,
  'settings/orchestration-loading': () => <SettingsOrchestrationLoading />,
  'settings/orchestration-empty-roster': () => <SettingsOrchestrationEmptyRoster />,
  'settings/orchestration-no-workspace': () => <SettingsOrchestrationNoWorkspace />,
  'settings/dictation': () => <SettingsDictation />,
  'settings/workspaces': () => <SettingsWorkspaces />,
  'settings/privacy': () => <SettingsPrivacy />,
  'settings/about': () => <SettingsAbout />,
  'composer/controls-open': () => <ComposerControlsOpen />,
  'composer/controls-overflow': () => <ComposerControlsOverflow />,
  'composer/controls-states': () => <ComposerControlsStates />,
  'composer/attachment-chips': () => <AttachmentChips />,
  'composer/attachment-previews': () => <AttachmentPreviews />,
  'new-session/routes': () => <NewSessionWithRoutes />,
  'new-session/task-focus': () => <NewSessionTask text="Fix the flaky reconnect test" focus />,
  'new-session/task-over-limit': () => <NewSessionTask text={'x'.repeat(9000)} focus={false} />,
  'shell/add-pane-profiles': () => <AddPaneProfiles />,
  'shell/add-pane-disabled': () => <AddPaneDisabled />,
  'banner/reconnect': () => <ReconnectBannerStory error={null} />,
  'banner/reconnect-error': () => <ReconnectBannerStory error="connection refused" />,
  'notices/resting': () => <NoticesResting />,
  'notices/stacked': () => <NoticesStacked />,
  'notices/error': () => <NoticesError />,
  'notices/exiting': () => <NoticesExiting />,
  'notices/pane-corner': () => <NoticesPaneCorner />,
  'notices/orchestration': () => <NoticesOrchestration />,
  'nav/routines': () => <NavRoutines />,
  'nav/routines-empty': () => <NavRoutinesEmpty />,
  'nav/routine-editor': () => <NavRoutineEditor />,
  'nav/routine-editor-clock': () => <NavRoutineEditorClock />,
  'nav/routine-editor-interval': () => <NavRoutineEditorInterval />,
  'nav/routine-rows': () => <NavRoutineRows />,
  'nav/routine-run-outcomes': () => <NavRoutineRunOutcomes />,
  'nav/list-detail': () => <NavListDetailStates />,
  'nav/chrome-states': () => <NavChromeStates />,
  'harness/report': () => <HarnessReportStates />,
  'harness/report-loading': () => <HarnessReportLoadingStory />,
  'harness/history-empty': () => <HarnessHistoryEmptyStory />,
  'harness/findings-dismissed': () => <HarnessFindingsDismissedStory />,
  'harness/history': () => <HarnessHistoryStory />,
  'nav/skills': () => <NavSkills />,
  'nav/skills/graphite': () => <NavSkills />,
  'nav/skills/paper': () => <NavSkills />,
  'nav/mcp': () => <NavMcp />,
  'nav/mcp-detail': () => <NavMcpDetail />,
  'nav/mcp-form': () => <NavMcpForm />,
  'nav/hooks': () => <NavHooks />,
  'tasks/list': () => <TasksListStory />,
  'usage/page': () => <UsagePageStory />,
  'usage/error': () => <UsagePageStory state="error" />,
  'usage/stale': () => <UsagePageStory state="stale" />,
  'usage/empty': () => <UsagePageStory state="empty" />,
  'tasks/page': () => <TasksPageStory />,
  'tasks/detail': () => <TasksDetailStory />,
  'panes/lifecycle': () => <PaneLifecycleStory />,
  'panes/chrome-menu': () => <PaneMenuStory />,
  'panes/chrome-ended': () => <PaneEndedStory />,
  'panes/chrome-terminal': () => <PaneTerminalStatesStory />,
  'panes/chrome-misc': () => <PaneMiscStory />,
  'panes/title-controls': () => <RenameTitleStory />,
  'legacy/tags-forms': () => <TagsFormsStory />,
  'legacy/tag-editor': () => <TagEditorStory />,
  'tasks/roster': () => <TasksRosterStory />,
  'tasks/queue': () => <TasksQueueStory />,
  'tasks/overview-roster': () => <TasksOverviewRosterStory />,
  'shell-a/changes-graphite': () => <InspectorChangesGraphite />,
  'shell-a/changes-paper': () => <InspectorChangesPaper />,
  'shell-a/pr-graphite': () => <InspectorPrGraphite />,
  'shell-a/pr-paper': () => <InspectorPrPaper />,
  'shell-a/pr-browse': () => <PrBrowseCapture />,
  'shell-a/pr-browse-states': () => <PrBrowseStatesCapture />,
  'shell-a/pr-discussion': () => <PrDiscussionCapture />,
  'shell-a/pr-comment-edit': () => <PrCommentEditCapture />,
  'shell-a/pr-empty': () => <PrEmptyCapture />,
  'shell-a/pr-files': () => <PrFilesCapture />,
  'shell-a/pr-file-states': () => <PrFilesStatesCapture />,
  'shell-a/pr-actions': () => <PrActionsCapture />,
  'shell-a/pr-pickers': () => <PrPickerCapture />,
  'shell-a/pr-review': () => <PrReviewCapture />,
  'shell-a/pr-provider': () => <ReviewProviderCapture />,
  'shell-a/pr-provider-selected': () => <ReviewProviderSelectedCapture />,
  'shell-a/files-graphite': () => <InspectorFilesGraphite />,
  'shell-a/children-graphite': () => <InspectorChildrenGraphite />,
  'shell-a/children-paper': () => <InspectorChildrenPaper />,
  'files/narrow': () => <FilesNarrowGraphite />,
  'files/split': () => <FilesSplitGraphite />,
  'files/split-paper': () => <FilesSplitPaper />,
  'files/pane': () => <FilesPaneGraphite />,
  'files/tree-menu': () => <FilesTreeMenuGraphite />,
  'files/tab-menu': () => <FilesTabMenuGraphite />,
  'files/rename': () => <FilesRenameGraphite />,
  'files/empty': () => <FilesEmptyGraphite />,
  'files/root-error': () => <FilesRootErrorGraphite />,
  'settings/tasks': () => <TasksSettingsStory />,
  'settings/tasks-review-refusal': () => <TasksSettingsReviewRefusalStory />
}
