import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '../houston/client'
import { clampScmWidth, defaultScmWidth } from '../scmPanel'
import { loadSideState, saveSideState, selectOverviewChild, moveBrowserToGrid, type SideOpen } from '../sidePanel'
import { requestReveal } from '../editor/bufferStore'
import { SourceControlPanel, ScmResizeHandle, type SourceControlPanelProps } from './SourceControlPanel'
import { Icon } from './Icon'
import { IconClose, IconFolder, IconGitBranch, IconGrid, IconGlobe, IconPlus, IconExpand, IconCollapse } from './icons'
import { Tooltip } from './Tooltip'
import './sidePanel.css'

const BrowserPane = lazy(() => import('./BrowserPane').then((module) => ({ default: module.BrowserPane })))
const FilesPane = lazy(() => import('./FilesPane').then((module) => ({ default: module.FilesPane })))
const OverviewTab = lazy(() => import('./OverviewTab').then((module) => ({ default: module.OverviewTab })))

export function SidePanel(props: SourceControlPanelProps & {
  workspace: string
  expanded?: boolean
  onExpanded?: (expanded: boolean) => void
  focused?: boolean
  closed?: boolean
  onSendToTerminal?: (text: string) => void
  sessions: ReadonlyMap<number, SessionInfo>
  request: SideOpen | null
  onReviewChild: (child: SessionInfo) => void
  onMoveFile: (root: string, path: string) => void
  onFocusSide: () => void
  onFocusGrid: () => void
}): React.JSX.Element {
  const [state, setState] = useState(() => loadSideState(props.workspace))
  const [changedCount, setChangedCount] = useState(0)
  const root = useRef<HTMLElement>(null)
  const [hostWidth, setHostWidth] = useState(0)
  const [openFile, setOpenFile] = useState<{ path: string; line?: number; col?: number } | null>(null)
  useEffect(() => saveSideState(props.workspace, state), [props.workspace, state])
  useEffect(() => {
    const request = props.request
    if (!request) return
    setState((current) => {
      const tabs = [...current.tabs]
      if (request.kind === 'files') {
        tabs[1] = { kind: 'files', root: request.root }
        return { tabs, active: 1 }
      }
      if (request.kind === 'browser') {
        let active = tabs.findIndex((tab) => tab.kind === 'browser' && tab.id === request.id)
        if (active === -1) { active = tabs.length; tabs.push({ kind: 'browser', id: request.id, url: request.url }) }
        return { tabs, active }
      }
      let active = tabs.findIndex((tab) => tab.kind === 'overview' && tab.orchestrator === request.orchestrator)
      if (active === -1) { active = tabs.length; tabs.push(request) }
      return { tabs, active }
    })
    if (request.kind === 'files') {
      setOpenFile(request)
      if (request.line !== undefined) requestReveal(request.root, request.path, request.line, request.col)
    }
  }, [props.request])
  useEffect(() => {
    const host = root.current?.parentElement
    if (!host || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setHostWidth(host.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  const requested = localStorage.getItem("tr-scm-width") === null ? defaultScmWidth(window.innerWidth) : props.width
  const rendered = clampScmWidth(requested, hostWidth)
  const active = state.tabs[state.active]
  const close = (index: number): void => setState((current) => ({ tabs: current.tabs.filter((_, i) => i !== index), active: current.active === index ? 0 : current.active > index ? current.active - 1 : current.active }))
  const filesRoot = state.tabs.find((tab) => tab.kind === 'files')?.root ?? props.workspace
  return <aside ref={root} aria-label="Side panel" data-testid="side-panel" data-dir={props.dir ?? undefined} className={`side-panel ${props.expanded ? 'expanded' : ''} ${props.hiddenByOverlay ? 'invisible' : ''}`} style={{ width: props.expanded ? '100%' : rendered, maxWidth: '100%', display: props.closed ? 'none' : undefined }} inert={props.hiddenByOverlay} onFocusCapture={props.onFocusSide} onPointerDownCapture={props.onFocusSide} onKeyDown={(event) => {
    if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[role="dialog"], .ctx-menu')) { event.stopPropagation(); if (props.expanded) props.onExpanded?.(false); else props.onFocusGrid() }
  }}>
    {!props.expanded && <ScmResizeHandle requested={requested} rendered={rendered} hostWidth={hostWidth} onWidth={props.onWidth} onReset={props.onResetWidth} />}
    <div className="side-tabs" role="tablist" aria-label="Side panel tabs">
      {state.tabs.map((tab, index) => {
        const label = tab.kind === 'scm' ? 'Source control' : tab.kind === 'files' ? 'Files' : tab.kind === 'overview' ? props.sessions.get(tab.orchestrator)?.title ?? `Orchestrator ${tab.orchestrator}` : tab.url
        return <Tooltip key={tab.kind === 'overview' ? `overview-${tab.orchestrator}` : tab.kind === 'browser' ? tab.id : tab.kind} label={label} className={`side-tab-wrap ${index < 2 ? 'pinned' : ''}`}><div className={`side-tab ${state.active === index ? 'selected' : ''}`}>
          <button role="tab" aria-selected={state.active === index} onClick={() => setState((current) => ({ ...current, active: index }))} onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const next = (index + (event.key === 'ArrowRight' ? 1 : state.tabs.length - 1)) % state.tabs.length
            setState((current) => ({ ...current, active: next }))
            root.current?.querySelectorAll<HTMLButtonElement>('.side-tab [role="tab"]')[next]?.focus()
          }}><Icon glyph={tab.kind === 'scm' ? IconGitBranch : tab.kind === 'files' ? IconFolder : tab.kind === 'browser' ? IconGlobe : IconGrid} role="label" /><span className="side-label">{label}</span><SideTabCount tab={tab} sessions={props.sessions} changed={changedCount} /></button>
          {index >= 2 && <button aria-label={`Close ${label}`} onClick={() => close(index)}><Icon glyph={IconClose} role="label" /></button>}
        </div></Tooltip>
      })}
      <span className="side-tab-spacer" /><Tooltip className="side-tab-action" label="New browser tab"><button aria-label="New browser tab" onClick={() => setState((current) => ({ tabs: [...current.tabs, { kind: 'browser', id: `b${Date.now()}-${crypto.randomUUID()}`, url: '' }], active: current.tabs.length }))}><Icon glyph={IconPlus} role="label" /></button></Tooltip>
      <Tooltip className="side-tab-action" label={props.expanded ? 'Restore side panel (Esc)' : 'Expand side panel'}><button aria-label="Expand side panel" aria-pressed={!!props.expanded} onClick={() => props.onExpanded?.(!props.expanded)}><Icon glyph={props.expanded ? IconCollapse : IconExpand} role="label" /></button></Tooltip>
    </div>
    <div className="side-card">
      <div className={`flex-1 min-h-0 flex-col ${active.kind === 'scm' ? 'flex' : 'hidden'}`}><SourceControlPanel {...props} embedded onChangedCount={setChangedCount} /></div>
      {active.kind === 'files' && <Suspense fallback={<div />}><FilesPane key={filesRoot} node={{ kind: 'files', id: 'side-files', root: filesRoot }} workspaceDir={filesRoot} active onClose={props.onFocusGrid} onHeaderPointerDown={() => {}} panel openFile={openFile} onMoveToEditor={(path) => props.onMoveFile(filesRoot, path)} client={props.client} /></Suspense>}
      {active.kind === 'overview' && props.client && <Suspense fallback={<div />}><OverviewTab parentId={active.orchestrator} sessions={props.sessions} client={props.client} onClose={() => close(state.active)} onReview={(child) => { props.onReviewChild(child); setState((current) => ({ ...current, active: 0 })) }} /></Suspense>}
      {state.tabs.map((tab, index) => tab.kind === 'browser' && <div key={tab.id} className={`side-browser ${state.active === index ? 'flex' : 'hidden'}`}><Suspense fallback={<div />}><BrowserPane node={{ kind: 'browser', id: tab.id, url: tab.url }} workspaceDir={props.workspace} loadRequest={props.request?.kind === 'browser' && !props.request.revealOnly && props.request.id === tab.id ? props.request : undefined} active={state.active === index && !props.closed && props.focused !== false} hiddenByExpand={props.closed || state.active !== index || props.hiddenByOverlay} panel onNavigate={(url) => setState((current) => ({ ...current, tabs: current.tabs.map((item) => item.kind === 'browser' && item.id === tab.id ? { ...item, url } : item) }))} onClose={() => close(index)} onMoveToGrid={(url) => { moveBrowserToGrid(tab.id, url, props.workspace); close(index) }} onHeaderPointerDown={() => {}} onSendToTerminal={props.onSendToTerminal} /></Suspense></div>)}
    </div>
  </aside>
}

export function SidePanelIntegration({ selectedWorkspace, activeId, sessions, request, reviewChild, onSurface, onFocusPane, onRevealWorkspace, onOpenEditor, onReviewChild, ...props }: SourceControlPanelProps & {
  selectedWorkspace: string
  expanded?: boolean
  onExpanded?: (expanded: boolean) => void
  focused?: boolean
  closed?: boolean
  onSendToTerminal?: (text: string) => void
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
  const workspace = selectedWorkspace === 'all' ? sessions.get(activeId ?? -1)?.project_dir ?? 'all' : selectedWorkspace
  return <SidePanel {...props} key={workspace} workspace={workspace} sessions={sessions} request={request} reviewTarget={reviewChild?.id} onReviewChild={onReviewChild}
    onFocusSide={() => onSurface('side')}
    onFocusGrid={() => { onSurface('grid'); if (activeId !== null) { onFocusPane(activeId); selectOverviewChild(activeId, null) } }}
    onMoveFile={(root, path) => { onRevealWorkspace(root); onOpenEditor(root, path, null); onSurface('grid') }} />
}

function SideTabCount({ tab, sessions, changed }: { tab: import('../sidePanel').SideTab; sessions: ReadonlyMap<number, SessionInfo>; changed: number }): React.JSX.Element | null {
  if (tab.kind === 'scm') return changed > 0 ? <span className="side-count">{changed}</span> : null
  if (tab.kind !== 'overview') return null
  const count = [...sessions.values()].filter((child) => child.spawned_by === tab.orchestrator && child.status === 'needs-input').length
  return count > 0 ? <span className="side-needs">{count}</span> : null
}
