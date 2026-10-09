import { MascotStory } from './mascotStories'
import React from 'react'
import {
  BrowserActModalStory,
  BrowserActOverlayStory,
  BrowserFullscreenStory,
  BrowserPaneFocused,
  BrowserPaneFresh,
  BrowserPaneInsecure,
  BrowserPaneNarrow,
  BrowserPanePage,
  BrowserPanePersistError,
  BrowserPanePhone,
  BrowserPaneTablet,
  BrowserPaneTabs,
  BrowserPickerError,
  BrowserPickerHint,
  BrowserPickerSelected
} from './browserStories'
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
import { AppearancePickerStory, SettingsAbout, SettingsAboutAvailable, SettingsAboutInstallState, SettingsAboutNotices, SettingsAgentSetup, SettingsAgentStatusEmpty, SettingsAgentStatusLoading, SettingsAppearance, SettingsAppearanceCustom, SettingsDaemon, SettingsDaemonError, SettingsDetailStory, SettingsDiagnostics, SettingsDiagnosticsLoading, SettingsDiagnosticsOpenHooks, SettingsDictation, SettingsDictationCloud, SettingsDictationModelStates, SettingsNoticesLoaded, SettingsNotifications, SettingsOrchestration, SettingsOrchestrationEmptyRoster, SettingsOrchestrationLoading, SettingsOrchestrationNoWorkspace, SettingsPrivacy, SettingsPrivacyEditor, SettingsSearchStory, SettingsShortcuts, SettingsShortcutsArmed, SettingsShortcutsConflict, SettingsTerminal, SettingsWorkspaces } from './settingsStories'
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
import { HandoffStatesStory, PaneHandoffSelectedStory, QuestionStatesStory, DelegationPanelsStory } from './orchestrationStories'
import { PaneLifecycleStory, TasksChipsStory, TasksComposerStory, TasksDetailStatesStory, TasksDetailStory, TasksListStatesStory, TasksListStory, TasksQueueEmptyStory, TasksQueueResultStory, TasksQueueStory, TasksRosterStory, TasksSettingsReviewRefusalStory, TasksSettingsStory, TasksOverviewRosterStory, TasksStartStory } from './tasksStories'
import { RenameTitleStory } from './renameTitleStories'

document.documentElement.setAttribute('data-motion-paused', '')
import { TasksByProjectStory, TasksPageStory, TasksProjectsDialogStory } from './tasksPageStory'
import { TrackerSettingsStory } from './projectsStories'
import { UsagePageStory } from './usagePageStory'
import { AddPanePopover } from '../src/components/AddPanePopover'
import { WorkspaceEmpty } from '../src/components/WorkspaceEmpty'

const STORY_ACTIONS = [{ id: 'test', name: 'test', command: 'bun run test', shortcut: null }, { id: 'dev', name: 'dev', command: 'bun run dev', shortcut: null }]
import { StaleWorktreesStory, UiPrimitivesStory } from './uiStories'
import { AddPaneDisabled, AddPaneProfiles, AttachmentChips, AttachmentPreviews, ComposerControlsOpen, ComposerControlsOverflow, ComposerControlsStates, NewSessionTask, NewSessionWithRoutes, ReconnectBannerStory } from './composerStories'
import { FilesEmptyGraphite, FilesNarrowGraphite, FilesPaneGraphite, FilesRenameGraphite, FilesRootErrorGraphite, FilesSplitGraphite, FilesSplitPaper, FilesTabMenuGraphite, FilesTreeMenuGraphite } from './filesStories'
import { FilesSurfaceDelete470, FilesSurfaceDiskChanged, FilesSurfaceFile340, FilesSurfaceFile470, FilesSurfaceFile600, FilesSurfaceFile732, FilesSurfaceImage470, FilesSurfaceImage732, FilesSurfaceMarkdown470, FilesSurfaceMarkdown732, FilesSurfaceOpenIn, FilesSurfaceQuickOpen, FilesSurfaceTree340, FilesSurfaceTree470, FilesSurfaceTree600, FilesSurfaceTree732 } from './filesSurfaceStories'
import { EditorSurfaceMenuStory, LayoutDropSlotsStory, MarkdownPreviewStory, OpenInSubmenuStory, EditorPreviewStatesStory, DictationListeningStory, DictationTranscribingStory, WindowControlsStory } from './workbenchStories'
import { PaletteGraphiteStory, PalettePaperStory } from './paletteStories'
import { InspectorChangesGraphite, InspectorChangesPaper, InspectorChildrenGraphite, InspectorChildrenPaper, InspectorFilesGraphite, InspectorOverviewStory, InspectorPrGraphite, InspectorPrPaper, SurfaceBrowserEmpty, SurfaceBrowserEmpty340, SurfaceBrowserPage, SurfaceBrowserPage340, SurfaceDiff, SurfaceDiff340, SurfaceDiff600, SurfaceDiff732, SurfaceDiffGraphite, SurfaceLauncher, SurfacePrFailing, SurfacePrFailing340, SurfacePrFailing600, SurfacePrFailing732, SurfacePrPassing, SurfaceWidth340, SurfaceWidth470, SurfaceWidth600, SurfaceWidth732 } from './inspectorStories'
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
import { TagPopoverHost } from '../src/components/tags/TagPopover'
import type { PrInfo } from '../src/houston/client'
import { FirstRunHooksStepSpecimen } from '../src/components/ui/FirstRunHooksStep'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'
import { SlackConnectionsStory } from './integrationStories'
import { BootFailureStory, BootLoadingStory, FirstRunOrchestrationStory, FirstRunWorkspaceStory, HostKeyChangedStory, ShortcutsOffStory, SshAdvancedStory, UpdateEmptyStory, UpdateInstallingStory, UpdateKeepStory, UpdateRunningStory, UpdateStopStory, UpdateUnsupportedStory } from './modalStates'
import { PrActionsCapture, PrBrowseCapture, PrBrowseStatesCapture, PrCommentEditCapture, PrDiscussionCapture, PrEmptyCapture, PrFilesCapture, PrFilesStatesCapture, PrPickerCapture, PrReviewCapture, ReviewProviderCapture, ReviewProviderSelectedCapture } from './prCloseoutStories'
import { PaneCheckoutHeaderStory, PaneEndedStory, PaneMenuStory, PaneMiscStory, PaneRecoveryDeferredStory, PaneSleepingStory, PaneTerminalStatesStory, TagsFormsStory } from './paneChromeStories'
import { SkillsDeleteConfirm, SkillsEmbeddedA, SkillsEmbeddedB, SkillsEmbeddedC, SkillsEmbeddedD, SkillsInstallBlank, SkillsInstallConflict, SkillsInstallPreview, SkillsInstallUrl, SkillsRowActions, SkillsStandaloneA, SkillsStandaloneB, SkillsStandaloneC } from './skillsStories'
import { RAIL_STORIES } from './railStories'
import { PullRequestDetailStory, PullRequestsScreenStory } from './prsStories'

const noop = (): void => {}

function RailGridRowStory({ theme, width }: { theme: 'graphite' | 'paper'; width: number }): React.JSX.Element {
  React.useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  const sessions = [
    { id: 11, agent: 'claude', project_dir: '/work/houston', cwd: '/work/houston', checkout_root: '/work/houston', state: 'running', status: 'working', status_since_ms: Date.now() - 14 * 60_000, title: 'Rail implementation', codename: 'Rail', hidden: false, live_children: 1, children_waiting: 0, context: { used_percent: 63 }, task: { key: 'HOU-411' }, spawned_by: null },
    { id: 12, agent: 'codex', project_dir: '/work/houston', cwd: '/work/houston-wt', worktree: { path: '/work/houston-wt', branch: 'ui/p4-rail' }, state: 'running', status: 'needs-input', status_since_ms: Date.now() - 4 * 60_000, title: 'Review rail states', codename: 'Review', hidden: false, live_children: 0, children_waiting: 0, context: { used_percent: 91 }, task: { key: 'HOU-412' }, spawned_by: 11 }
  ] as unknown as SessionInfo[]
  const pr: PrInfo = {
    number: 411,
    url: 'https://github.com/example/houston/pull/411',
    state: 'OPEN',
    review_decision: 'REVIEW_REQUIRED',
    checks: 'running',
    title: 'Redesign the surfaces',
    head_ref: 'ui/p4-rail',
    additions: 142,
    deletions: 39,
    is_draft: false,
  }
  const store = React.useMemo(() => createSessionsStore(new Map(sessions.map((session) => [session.id, session]))), [])
  const tags = [{ id: 1, name: 'Bug', color: '#f472b6' }, { id: 2, name: 'Teste', color: '#f59e0b' }]
  return <div style={{ width, height: '100%', padding: 18, background: 'var(--background)' }}>
    <SessionsStoreContext.Provider value={store}>
      <TagPopoverHost tags={tags} grids={[{ id: 'grid-rail', title: 'Rail implementation', tags: [1, 2] }]} actions={{ onCreate: (name, color) => ({ id: 3, name, color }), onUpdate: noop, onDelete: noop, onApply: noop }}>
        <GridRailRow name="Rail implementation" workspace="/work/houston" gridId="grid-rail" selected paneIds={[11, 12]} tags={tags} fallbackSessions={sessions} branches={new Map([[11, 'ui/p4-rail'], [12, 'ui/p4-rail']])} diffByDir={new Map([['/work/houston', { added: 142, deleted: 39, ahead: 2, behind: 0, changedFiles: 5 }], ['/work/houston-wt', { added: 24, deleted: 8, ahead: 0, behind: 1, changedFiles: 2 }]])} prByDir={new Map([['/work/houston', { gh: 'ready', pr }]])} jumpNumber={1} onSelect={noop} onOpenInspector={noop} />
      </TagPopoverHost>
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
  mascot: () => <MascotStory />,
  'browser/pane': () => <BrowserPanePage />,
  'browser/pane-focused': () => <BrowserPaneFocused />,
  'browser/pane-fresh': () => <BrowserPaneFresh />,
  'browser/pane-narrow': () => <BrowserPaneNarrow />,
  'browser/pane-insecure': () => <BrowserPaneInsecure />,
  'browser/pane-phone': () => <BrowserPanePhone />,
  'browser/pane-tablet': () => <BrowserPaneTablet />,
  'browser/pane-tabs': () => <BrowserPaneTabs />,
  'browser/pane-persist-error': () => <BrowserPanePersistError />,
  'browser/picker-hint': () => <BrowserPickerHint />,
  'browser/picker-selected': () => <BrowserPickerSelected />,
  'browser/picker-error': () => <BrowserPickerError />,
  'browser/fullscreen': () => <BrowserFullscreenStory />,
  'browser/act-overlay': () => <BrowserActOverlayStory />,
  'browser/act-modal': () => <BrowserActModalStory />,
  'new-session/default': () => <NewSession />,
  'shell/add-pane-menu': () => <AddPanePopover right={24} y={24} hasWorkspace keymapOverrides={{ bindings: {}, shortcuts_enabled: true }} onClose={() => {}} onNewTerminal={() => {}} onSpawnAgent={() => {}} onSplitDown={() => {}} onNewGrid={() => {}} agentProfiles={null} workspaceActions={STORY_ACTIONS} />,
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
  'orchestration/handoff-states': () => <HandoffStatesStory />,
  'orchestration/pane-handoff-selected': () => <PaneHandoffSelectedStory />,
  'orchestration/question-states': () => <QuestionStatesStory />,
  'orchestration/delegation-panels': () => <DelegationPanelsStory />,
  'ui-primitives': () => <UiPrimitivesStory />,
  'git/worktree-stale': () => <StaleWorktreesStory />,
  'editor/markdown-preview': () => <MarkdownPreviewStory />,
  'editor/surface-menu': () => <EditorSurfaceMenuStory />,
  'editor/preview-states': () => <EditorPreviewStatesStory />,
  'voice/dictation-listening': () => <DictationListeningStory />,
  'voice/dictation-transcribing': () => <DictationTranscribingStory />,
  'shell/window-controls-resize': () => <WindowControlsStory />,
  'layout/drop-slots-splitter': () => <LayoutDropSlotsStory />,
  'shell/open-in-submenu': () => <OpenInSubmenuStory />,
  'files/surface-340': () => <FilesSurfaceTree340 />,
  'files/surface-470': () => <FilesSurfaceTree470 />,
  'files/surface-600': () => <FilesSurfaceTree600 />,
  'files/surface-732': () => <FilesSurfaceTree732 />,
  'files/surface-file-340': () => <FilesSurfaceFile340 />,
  'files/surface-file-470': () => <FilesSurfaceFile470 />,
  'files/surface-file-600': () => <FilesSurfaceFile600 />,
  'files/surface-file-732': () => <FilesSurfaceFile732 />,
  'files/surface-quick-open': () => <FilesSurfaceQuickOpen />,
  'files/surface-disk-changed': () => <FilesSurfaceDiskChanged />,
  'files/surface-open-in': () => <FilesSurfaceOpenIn />,
  'files/surface-markdown-470': () => <FilesSurfaceMarkdown470 />,
  'files/surface-markdown-732': () => <FilesSurfaceMarkdown732 />,
  'files/surface-image-470': () => <FilesSurfaceImage470 />,
  'files/surface-image-732': () => <FilesSurfaceImage732 />,
  'files/surface-delete-470': () => <FilesSurfaceDelete470 />,
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
  'prs/screen-paper': () => <PullRequestsScreenStory />,
  'prs/screen-empty': () => <PullRequestsScreenStory mode="empty" />,
  'prs/screen-loading': () => <PullRequestsScreenStory mode="loading" />,
  'prs/screen-sort-menu': () => <PullRequestsScreenStory mode="sort" />,
  'prs/screen-filter-menu': () => <PullRequestsScreenStory mode="filters" />,
  'prs/screen-hover': () => <PullRequestsScreenStory mode="hover" />,
  'prs/screen-selected': () => <PullRequestsScreenStory mode="selected" />,
  'prs/screen-folded': () => <PullRequestsScreenStory mode="folded" />,
  'prs/screen-timeline': () => <PullRequestsScreenStory mode="timeline" />,
  'prs/screen-code': () => <PullRequestsScreenStory mode="code" />,
  'prs/screen-draft': () => <PullRequestsScreenStory mode="draft" />,
  'prs/screen-closed': () => <PullRequestsScreenStory mode="closed" />,
  'prs/detail-timeline-470': () => <PullRequestDetailStory width={470} tab="timeline" />,
  'prs/detail-timeline-732': () => <PullRequestDetailStory width={732} tab="timeline" />,
  'prs/detail-code-470': () => <PullRequestDetailStory width={470} tab="code" />,
  'prs/detail-code-732': () => <PullRequestDetailStory width={732} tab="code" />,
  'prs/detail-draft-470': () => <PullRequestDetailStory width={470} state="draft" />,
  'prs/detail-draft-732': () => <PullRequestDetailStory width={732} state="draft" />,
  'prs/detail-merged-470': () => <PullRequestDetailStory width={470} state="merged" />,
  'prs/detail-merged-732': () => <PullRequestDetailStory width={732} state="merged" />,
  'prs/detail-closed-470': () => <PullRequestDetailStory width={470} state="closed" />,
  'prs/detail-closed-732': () => <PullRequestDetailStory width={732} state="closed" />,
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
  'settings/diagnostics-loading': () => <SettingsDiagnosticsLoading />,
  'settings/diagnostics-open-hooks': () => <SettingsDiagnosticsOpenHooks />,
  'settings/daemon': () => <SettingsDaemon />,
  'settings/daemon-error': () => <SettingsDaemonError />,
  'settings/orchestration': () => <SettingsOrchestration />,
  'settings/orchestration-loading': () => <SettingsOrchestrationLoading />,
  'settings/orchestration-empty-roster': () => <SettingsOrchestrationEmptyRoster />,
  'settings/orchestration-no-workspace': () => <SettingsOrchestrationNoWorkspace />,
  'settings/dictation': () => <SettingsDictation />,
  'settings/dictation-model-states': () => <SettingsDictationModelStates />,
  'settings/dictation-cloud-error': () => <SettingsDictationCloud />,
  'settings/workspaces': () => <SettingsWorkspaces />,
  'settings/privacy': () => <SettingsPrivacy />,
  'settings/privacy-edit': () => <SettingsPrivacyEditor />,
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
  'settings/about-available': () => <SettingsAboutAvailable />,
  'settings/about-installing': () => <SettingsAboutInstallState state={{ kind: 'downloading', downloaded: 3_200_000, total: 8_000_000 }} />,
  'settings/about-install-failed': () => <SettingsAboutInstallState state={{ kind: 'failed', version: '1.2.3', error: 'Signature verification failed' }} />,
  'settings/about-notices': () => <SettingsAboutNotices />,
  'settings/notices-loaded': () => <SettingsNoticesLoaded />,
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
  'skills/standalone-a': () => <SkillsStandaloneA />,
  'skills/standalone-b': () => <SkillsStandaloneB />,
  'skills/standalone-c': () => <SkillsStandaloneC />,
  'skills/row-actions': () => <SkillsRowActions />,
  'skills/embedded-a': () => <SkillsEmbeddedA />,
  'skills/embedded-b': () => <SkillsEmbeddedB />,
  'skills/embedded-c': () => <SkillsEmbeddedC />,
  'skills/embedded-d': () => <SkillsEmbeddedD />,
  'skills/delete-confirm': () => <SkillsDeleteConfirm />,
  'skills/install-blank': () => <SkillsInstallBlank />,
  'skills/install-url': () => <SkillsInstallUrl />,
  'skills/install-preview': () => <SkillsInstallPreview />,
  'skills/install-conflict': () => <SkillsInstallConflict />,
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
  'tasks/by-project': () => <TasksByProjectStory />,
  'tasks/projects-dialog': () => <TasksProjectsDialogStory />,
  'settings/tasks-tracker': () => <TrackerSettingsStory />,
  'tasks/detail': () => <TasksDetailStory />,
  'tasks/start-card': () => <TasksStartStory />,
  'panes/lifecycle': () => <PaneLifecycleStory />,
  'panes/chrome-menu': () => <PaneMenuStory />,
  'surface/pane-header': () => <PaneCheckoutHeaderStory />,
  'panes/chrome-ended': () => <PaneEndedStory />,
  'panes/sleeping': () => <PaneSleepingStory />,
  'panes/recovery-deferred': () => <PaneRecoveryDeferredStory />,
  'panes/chrome-terminal': () => <PaneTerminalStatesStory />,
  'panes/chrome-misc': () => <PaneMiscStory />,
  'panes/title-controls': () => <RenameTitleStory />,
  'legacy/tags-forms': () => <TagsFormsStory />,
  'tasks/roster': () => <TasksRosterStory />,
  'tasks/list-states': () => <TasksListStatesStory />,
  'tasks/composer': () => <TasksComposerStory />,
  'tasks/detail-states': () => <TasksDetailStatesStory />,
  'tasks/chips': () => <TasksChipsStory />,
  'tasks/queue': () => <TasksQueueStory />,
  'tasks/queue-empty': () => <TasksQueueEmptyStory />,
  'tasks/queue-result': () => <TasksQueueResultStory />,
  'tasks/overview-roster': () => <TasksOverviewRosterStory />,
  'shell-a/changes-graphite': () => <InspectorChangesGraphite />,
  'shell-a/changes-paper': () => <InspectorChangesPaper />,
  'surface/launcher': () => <SurfaceLauncher />,
  'surface/diff': () => <SurfaceDiff />,
  'surface/diff-graphite': () => <SurfaceDiffGraphite />,
  'surface/diff-340': () => <SurfaceDiff340 />,
  'surface/diff-600': () => <SurfaceDiff600 />,
  'surface/diff-732': () => <SurfaceDiff732 />,
  'surface/pr-passing': () => <SurfacePrPassing />,
  'surface/pr-failing-expanded': () => <SurfacePrFailing />,
  'surface/pr-failing-340': () => <SurfacePrFailing340 />,
  'surface/pr-failing-600': () => <SurfacePrFailing600 />,
  'surface/pr-failing-732': () => <SurfacePrFailing732 />,
  'surface/browser-empty': () => <SurfaceBrowserEmpty />,
  'surface/browser-page': () => <SurfaceBrowserPage />,
  'surface/browser-empty-340': () => <SurfaceBrowserEmpty340 />,
  'surface/browser-page-340': () => <SurfaceBrowserPage340 />,
  'surface/width-340': () => <SurfaceWidth340 />,
  'surface/width-470': () => <SurfaceWidth470 />,
  'surface/width-600': () => <SurfaceWidth600 />,
  'surface/width-732': () => <SurfaceWidth732 />,
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
  'settings/tasks-review-refusal': () => <TasksSettingsReviewRefusalStory />,
  ...RAIL_STORIES
}
