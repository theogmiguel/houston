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

function NewSessionClicked({ selector }: { selector: string }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(selector)?.click()
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
import { SettingsAgentSetup, SettingsAppearance, SettingsDiagnostics, SettingsTerminal } from './settingsStories'
import {
  NoticesError,
  NoticesExiting,
  NoticesPaneCorner,
  NoticesResting,
  NoticesStacked
} from './noticeStories'

import {
  NavHooks,
  NavMcp,
  NavMcpDetail,
  NavRoutineEditor,
  NavRoutines,
  NavRoutinesEmpty,
  NavSkills,
  HarnessPageStory
} from './navStories'
import { TasksDetailStory, TasksListStory, TasksQueueStory, TasksRosterStory, TasksSettingsStory } from './tasksStories'
import { TasksPageStory } from './tasksPageStory'
import { UsagePageStory } from './usagePageStory'
import { UiPrimitivesStory } from './uiStories'
import { PaletteGraphiteStory, PalettePaperStory } from './paletteStories'
import { InspectorChangesGraphite, InspectorChangesPaper, InspectorChildrenGraphite, InspectorChildrenPaper, InspectorPrGraphite, InspectorPrPaper } from './inspectorStories'
import { GridRailRow } from '../src/components/ui/GridRailRow'
import { createSessionsStore, SessionsStoreContext } from '../src/sessionsStore'

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
      <GridRailRow name="Rail implementation" selected paneIds={[11, 12]} fallbackSessions={sessions} branches={new Map([[11, 'ui/p4-rail'], [12, 'ui/p4-rail']])} diffByDir={new Map([['/work/houston', { added: 142, deleted: 39, ahead: 2, behind: 0, changedFiles: 5 }], ['/work/houston-wt', { added: 24, deleted: 8, ahead: 0, behind: 1, changedFiles: 2 }]])} prByDir={new Map([['/work/houston', { gh: 'ready', pr: { number: 411, url: 'https://github.com/example/houston/pull/411', state: 'OPEN', review_decision: 'REVIEW_REQUIRED', checks: 'running' } }]])} width={width} jumpNumber={1} onSelect={noop} onOpenInspector={noop} onOpenExternal={noop} />
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
  'launch/docked': () => <DockedLaunchStory />,
  'launch/docked-preset-hover': () => <DockedLaunchHoverStory />,
  'new-session/swarm': () => <NewSessionClicked selector='[data-preset="swarm"]' />,
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
  'ui-primitives': () => <UiPrimitivesStory />,
  'palette/graphite': () => <PaletteGraphiteStory />,
  'palette/paper': () => <PalettePaperStory />,
  'harness/page': () => <HarnessPageStory />,
  'rail/workspaces-multi': () => <RailWorkspacesMulti />,
  'rail/grid-row-graphite-200': () => <RailGridRowStory theme="graphite" width={200} />,
  'rail/grid-row-graphite-240': () => <RailGridRowStory theme="graphite" width={240} />,
  'rail/grid-row-graphite-420': () => <RailGridRowStory theme="graphite" width={420} />,
  'rail/grid-row-paper-200': () => <RailGridRowStory theme="paper" width={200} />,
  'rail/grid-row-paper-240': () => <RailGridRowStory theme="paper" width={240} />,
  'rail/grid-row-paper-420': () => <RailGridRowStory theme="paper" width={420} />,
  'settings/agent-setup': () => <SettingsAgentSetup />,
  'settings/appearance': () => <SettingsAppearance />,
  'settings/terminal': () => <SettingsTerminal />,
  'settings/diagnostics': () => <SettingsDiagnostics />,
  'notices/resting': () => <NoticesResting />,
  'notices/stacked': () => <NoticesStacked />,
  'notices/error': () => <NoticesError />,
  'notices/exiting': () => <NoticesExiting />,
  'notices/pane-corner': () => <NoticesPaneCorner />,
  'nav/routines': () => <NavRoutines />,
  'nav/routines-empty': () => <NavRoutinesEmpty />,
  'nav/routine-editor': () => <NavRoutineEditor />,
  'nav/skills': () => <NavSkills />,
  'nav/skills/graphite': () => <NavSkills />,
  'nav/skills/paper': () => <NavSkills />,
  'nav/mcp': () => <NavMcp />,
  'nav/mcp-detail': () => <NavMcpDetail />,
  'nav/hooks': () => <NavHooks />,
  'tasks/list': () => <TasksListStory />,
  'usage/page': () => <UsagePageStory />,
  'tasks/page': () => <TasksPageStory />,
  'tasks/detail': () => <TasksDetailStory />,
  'tasks/roster': () => <TasksRosterStory />,
  'tasks/queue': () => <TasksQueueStory />,
  'shell-a/changes-graphite': () => <InspectorChangesGraphite />,
  'shell-a/changes-paper': () => <InspectorChangesPaper />,
  'shell-a/pr-graphite': () => <InspectorPrGraphite />,
  'shell-a/pr-paper': () => <InspectorPrPaper />,
  'shell-a/children-graphite': () => <InspectorChildrenGraphite />,
  'shell-a/children-paper': () => <InspectorChildrenPaper />,
  'settings/tasks': () => <TasksSettingsStory />
}
