import { lazy, Suspense, useEffect, useState } from 'react'
import type { SessionInfo } from '../houston/client'
import type { ChangesSummary } from './ChangesPane'
import { clampScmWidth, defaultScmWidth, type ScmTab } from '../scmPanel'
import { selectOverviewChild, type SideOpen } from '../sidePanel'
import { requestReveal } from '../editor/bufferStore'
import { SourceControlPanel, ScmResizeHandle, type SourceControlPanelProps } from './SourceControlPanel'
import { InspectorHeader } from './ui/InspectorHeader'
import { IconAgent } from './icons'
import './sidePanel.css'
import './tasks/tasks.css'

const FilesPane = lazy(() => import('./FilesPane').then((module) => ({ default: module.FilesPane })))
const OverviewTab = lazy(() => import('./OverviewTab').then((module) => ({ default: module.OverviewTab })))

type InspectorTab = ScmTab | 'files' | 'overview'
type SidePanelProps = SourceControlPanelProps & {
  workspace: string
  workspaces?: { path: string; name: string }[]
  focused?: boolean
  closed?: boolean
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel?: string
  sessions: ReadonlyMap<number, SessionInfo>
  activeSessionId?: number | null
  request: SideOpen | null
  onReviewChild: (child: SessionInfo) => void
  onMoveFile: (root: string, path: string) => void
  onFocusSide: () => void
  onFocusGrid: () => void
}

function hasChildren(session: SessionInfo | undefined, sessions: ReadonlyMap<number, SessionInfo>): boolean {
  return session != null && [...sessions.values()].some((item) => item.spawned_by === session.id)
}

function InspectorContent({ props, tab, focused, isOrchestrator, filesRoot, openFile, setTab, setSummary }: {
  props: SidePanelProps
  tab: InspectorTab
  focused: SessionInfo | undefined
  isOrchestrator: boolean
  filesRoot: string
  openFile: { path: string; line?: number; col?: number } | null
  setTab: (tab: InspectorTab) => void
  setSummary: (summary: ChangesSummary) => void
}): React.JSX.Element | null {
  if (tab === 'changes' || tab === 'pull-request') {
    return <div className="side-card"><SourceControlPanel {...props} key={`${props.dir ?? 'none'}:${props.activeSessionId ?? 'none'}`} session={props.activeSessionId} tab={tab} hideHeader onSummaryChange={setSummary} embedded /></div>
  }
  if (tab === 'files') {
    return <Suspense fallback={<div className="flex-1" />}><FilesPane key={filesRoot} node={{ kind: 'files', id: 'inspector-files', root: filesRoot }} workspaceDir={filesRoot} active onClose={props.onFocusGrid} onHeaderPointerDown={() => {}} panel openFile={openFile} onMoveToEditor={(path) => props.onMoveFile(filesRoot, path)} client={props.client} onSendToTerminal={props.onSendToTerminal} sendToTerminalLabel={props.sendToTerminalLabel} /></Suspense>
  }
  if (tab === 'overview' && isOrchestrator && props.client && focused) {
    return <Suspense fallback={<div className="flex-1" />}><OverviewTab parentId={focused.id} sessions={props.sessions} client={props.client} onClose={() => setTab('changes')} onReview={(child) => { props.onReviewChild(child); setTab('changes') }} /></Suspense>
  }
  return null
}

function PaneInspectorHeader({ props, focused, isOrchestrator, tab, summary, onTab }: {
  props: SidePanelProps
  focused: SessionInfo | undefined
  isOrchestrator: boolean
  tab: InspectorTab
  summary: ChangesSummary | null
  onTab: (tab: string) => void
}): React.JSX.Element {
  const checkout = focused?.worktree?.path
    ? `wt/${focused.worktree.path.split(/[\\/]/).filter(Boolean).at(-1)}`
    : summary?.branch ?? focused?.checkout_root ?? props.dir ?? ''
  const tabs = [
    { id: 'changes', label: 'Changes', count: summary?.changed },
    { id: 'pull-request', label: 'PR' },
    { id: 'files', label: 'Files' },
    ...(isOrchestrator ? [{ id: 'overview', label: 'Overview' }] : [])
  ]
  return <InspectorHeader tabs={tabs} active={tab} onSelect={onTab} icon={focused ? <IconAgent brand agent={focused.detected_agent ?? focused.agent} /> : null} title={focused?.title ?? 'No focused pane'} checkout={checkout} ahead={summary?.ahead} branch={summary?.branch} />
}

export function SidePanel(props: SidePanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<InspectorTab>(props.tab)
  const [summary, setSummary] = useState<ChangesSummary | null>(null)
  const [openFile, setOpenFile] = useState<{ path: string; line?: number; col?: number } | null>(null)
  const [filesRoot, setFilesRoot] = useState(props.dir ?? props.workspace)
  const [hostWidth, setHostWidth] = useState(0)
  const focused = props.activeSessionId == null ? undefined : props.sessions.get(props.activeSessionId)
  const isOrchestrator = hasChildren(focused, props.sessions)
  useEffect(() => { setActiveTab(props.tab) }, [props.tab])
  useEffect(() => { setFilesRoot(props.dir ?? props.workspace); setOpenFile(null) }, [props.activeSessionId, props.dir, props.workspace])
  useEffect(() => {
    const request = props.request
    if (request?.kind === 'overview' && request.orchestrator === props.activeSessionId && isOrchestrator) setActiveTab('overview')
    if (request?.kind === 'files') {
      setFilesRoot(request.root)
      setOpenFile(request)
      setActiveTab('files')
      if (request.line !== undefined) requestReveal(request.root, request.path, request.line, request.col)
    }
  }, [props.request, props.activeSessionId, isOrchestrator])
  useEffect(() => {
    if (activeTab === 'overview' && !isOrchestrator) setActiveTab('changes')
  }, [activeTab, isOrchestrator])
  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="side-panel-row"]')
    if (!host || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setHostWidth(host.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const requested = localStorage.getItem('tr-scm-width') === null ? defaultScmWidth(window.innerWidth) : props.width
  const rendered = clampScmWidth(requested, hostWidth)
  const selectTab = (tab: string): void => {
    const selected = tab as InspectorTab
    setActiveTab(selected)
    if (selected === 'changes' || selected === 'pull-request') props.onTab(selected)
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || (event.target as HTMLElement).closest('[role="dialog"], .ctx-menu')) return
    event.stopPropagation()
    props.onFocusGrid()
  }

  return <aside aria-label="Pane inspector" data-testid="side-panel" data-dir={props.dir ?? undefined} className={`pane-inspector ${props.hiddenByOverlay ? 'invisible' : ''}`} style={{ width: rendered, maxWidth: '100%', display: props.closed ? 'none' : undefined }} inert={props.hiddenByOverlay} onFocusCapture={props.onFocusSide} onPointerDownCapture={props.onFocusSide} onKeyDown={onKeyDown}>
    <ScmResizeHandle requested={requested} rendered={rendered} hostWidth={hostWidth} onWidth={props.onWidth} onReset={props.onResetWidth} />
    <PaneInspectorHeader props={props} focused={focused} isOrchestrator={isOrchestrator} tab={activeTab} summary={summary} onTab={selectTab} />
    <div className="pane-inspector-content"><InspectorContent props={props} tab={activeTab} focused={focused} isOrchestrator={isOrchestrator} filesRoot={filesRoot} openFile={openFile} setTab={setActiveTab} setSummary={setSummary} /></div>
  </aside>
}

export function SidePanelIntegration({ selectedWorkspace, activeId, sessions: sessionsProp, request, reviewChild, onSurface, onFocusPane, onRevealWorkspace, onOpenEditor, onReviewChild, ...props }: SourceControlPanelProps & {
  selectedWorkspace: string
  workspaces?: { path: string; name: string }[]
  focused?: boolean
  closed?: boolean
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel?: string
  activeId: number | null
  sessions: ReadonlyMap<number, SessionInfo>
  request: SideOpen | null
  reviewChild: SessionInfo | null
  onSurface: (surface: 'grid' | 'side') => void
  onFocusPane: (id: number) => void
  onRevealWorkspace: (root: string) => void
  onOpenEditor: (root: string, path: string, anchor: null) => void
  onReviewChild: (child: SessionInfo) => void
}): React.JSX.Element {
  const workspace = selectedWorkspace === 'all' ? sessionsProp.get(activeId ?? -1)?.project_dir ?? 'all' : selectedWorkspace
  return <SidePanel {...props} key={workspace} workspace={workspace} sessions={sessionsProp} request={request} activeSessionId={activeId} reviewTarget={reviewChild?.id} onReviewChild={onReviewChild}
    onFocusSide={() => onSurface('side')}
    onFocusGrid={() => { onSurface('grid'); if (activeId !== null) { onFocusPane(activeId); selectOverviewChild(activeId, null) } }}
    onMoveFile={(root, path) => { onRevealWorkspace(root); onOpenEditor(root, path, null); onSurface('grid') }} />
}
