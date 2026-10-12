import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo, PullRequestLink } from '../houston/client'
import { browserTabUrl, isBrowserSurface, clampScmWidth, defaultScmWidth, loadInspectorTabs, saveInspectorTabs, scmWidthMax, type SurfaceKind } from '../scmPanel'
import { isTauri } from '../houston/host'
import { tauriBrowserInvoke } from './browserTabs'
import { selectOverviewChild, updateSideBrowser, type SideOpen } from '../sidePanel'
import { requestReveal } from '../editor/bufferStore'
import { formatCheckout } from './checkout/formatCheckout'
import type { CheckAgentTarget } from './prs/ChecksList'
import { SourceControlPanel, ScmResizeHandle, type SourceControlPanelProps } from './SourceControlPanel'
import { InspectorSurface } from './ui/InspectorHeader'
import { useExitAnimation } from './ui/AnimOut'
import { PanelTab } from './ui/PanelTab'
import { LauncherRow } from './ui/LauncherRow'
import { Icon } from './ui/Icon'
import { GitPresenceDot } from './ui'
import type { ChangesSummary } from './ChangesPane'
import { IconGitBranch, IconGitPullRequest, IconGlobe, IconPlus, IconMaximize, IconMinimize } from './icons'
import { Tooltip } from './ui/Tooltip'
import { ShellElement } from './ui/ShellPrimitives'
import './ui/panel.css'

const INSPECTOR_EXIT_MS = 240
const BrowserSurface = lazy(() => import('./browser/BrowserSurface').then((module) => ({ default: module.BrowserSurface })))
const FilesSurface = lazy(() => import('./files/FilesSurface').then((module) => ({ default: module.FilesSurface })))
const OverviewTab = lazy(() => import('./OverviewTab').then((module) => ({ default: module.OverviewTab })))

function useSidePanelRequest(request: SidePanelProps['request'], activeSessionId: number | null | undefined, isOrchestrator: boolean, setOverviewTarget: React.Dispatch<React.SetStateAction<number | null>>, setFilesRoot: React.Dispatch<React.SetStateAction<string>>, openSurface: (surface: SurfaceKind) => void): void {
  useEffect(() => {
    if (request?.kind === 'overview' && request.orchestrator === activeSessionId && isOrchestrator) setOverviewTarget(request.orchestrator)
    if (request?.kind === 'files') {
      setFilesRoot(request.root)
      requestReveal(request.root, request.path, request.line ?? 1, request.col)
      openSurface('files')
    }
  }, [request, activeSessionId, isOrchestrator])
}

function pullRequestTone(link: PullRequestLink | undefined): 'stop' | 'warn' | 'ok' | null {
  if (!link) return null
  if (link.checks === 'failing') return 'stop'
  if (link.checks === 'running') return 'warn'
  return 'ok'
}

const SURFACE_META: Record<SurfaceKind, { label: string; shortcut: string; description: string; icon: React.ReactNode }> = {
  browser: { label: 'Browser', shortcut: 'B', description: 'Browse local pages', icon: <Icon glyph={IconGlobe} role="label" /> },
  files: { label: 'Files', shortcut: 'F', description: 'Browse and edit workspace files', icon: <PanelFilesIcon /> },
  diff: { label: 'Changes', shortcut: 'D', description: 'Review working tree changes', icon: <Icon glyph={IconGitBranch} role="label" /> },
  'pull-request': { label: 'Pull request', shortcut: 'P', description: 'Review this branch’s pull request', icon: <Icon glyph={IconGitPullRequest} role="label" /> },
  'linked-pull-requests': { label: 'Linked pull requests', shortcut: 'L', description: 'Review pull requests in this grid', icon: <PanelLinkIcon /> }
}
type SurfaceMeta = (typeof SURFACE_META)[SurfaceKind]

type SidePanelProps = Omit<SourceControlPanelProps, 'onCreateCheckAgent' | 'requestedPr'> & {
  onCreateCheckAgent?: (provider: string, text: string) => Promise<number | null>
  requestedPr?: PullRequestLink | null
  workspace: string
  workspaces?: { path: string; name: string }[]
  focused?: boolean
  open?: boolean
  keepMounted?: boolean
  onExitAnimationEnd?: () => void
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel?: string
  sessions: ReadonlyMap<number, SessionInfo>
  activeSessionId?: number | null
  request: SideOpen | null
  onBrowserRequestHandled?: (request: SideOpen) => void
  onReviewChild: (child: SessionInfo) => void
  onMoveFile: (root: string, path: string) => void
  onFocusSide: () => void
  onFocusGrid: () => void
  onFocusPane?: (id: number) => void
  linkedPullRequests?: PullRequestLink[]
  onSelectPullRequest?: (link: PullRequestLink) => void
  proactiveDiffEnabled?: boolean
  proactiveDiffRequest?: { id: number; hasDiff: boolean; userUntouched: boolean }
  isGitRepository?: boolean
  hasPullRequest?: boolean
  browserTabId?: string
  onUserActionCounterChange?: (count: number) => void
  openTabs?: SurfaceKind[]
}

function hasChildren(session: SessionInfo | undefined, sessions: ReadonlyMap<number, SessionInfo>): boolean {
  return session != null && [...sessions.values()].some((item) => item.spawned_by === session.id)
}

function gridCheckAgents(sessions: ReadonlyMap<number, SessionInfo>, workspace: string): CheckAgentTarget[] {
  const providers: Partial<Record<SessionInfo['agent'], string>> = {
    claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode', cursor: 'Cursor', grok: 'Grok', zcode: 'ZCode'
  }
  return [...sessions.values()].flatMap((session) => {
    if (session.project_dir !== workspace && session.checkout_root !== workspace && session.worktree?.repo_common_dir !== workspace) return []
    const provider = providers[session.agent]
    if (!provider) return []
    const slug = session.worktree?.path.split(/[\\/]/).filter(Boolean).at(-1)
    const checkoutInfo = (session as SessionInfo & { checkout?: Parameters<typeof formatCheckout>[0] }).checkout
    const checkout = checkoutInfo ?? (session.worktree
      ? { root: session.worktree.path, kind: { worktree: { slug: slug ?? 'worktree' } }, branch: session.worktree.branch, head: null } as Parameters<typeof formatCheckout>[0]
      : undefined)
    return [{ session: session.id, provider, label: session.codename || `${provider} ${session.id}`, checkout: formatCheckout(checkout).text }]
  })
}

function PanelFilesIcon(): React.JSX.Element {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
}

function PanelLinkIcon(): React.JSX.Element {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7" /></svg>
}

function browserSurfaceTitle(browserTitle: string, faviconUrl: string | null): { title: string; icon: React.ReactNode } {
  const icon = faviconUrl ? <img src={faviconUrl} alt="" className="h-3.5 w-3.5" /> : browserTitle && browserTitle !== 'New tab' ? <ShellElement as="span" shellRole="browser-tab-favicon">{browserTitle.slice(0, 1).toUpperCase()}</ShellElement> : SURFACE_META.browser.icon
  return { title: browserTitle || 'New tab', icon }
}

function pullRequestSurfaceTitle(number: number | null, reportedTone: string | null): { title: string; icon: React.ReactNode; badge: React.ReactNode } {
  const tone = reportedTone === 'stop' || reportedTone === 'warn' ? reportedTone : 'ok'
  const label = tone === 'stop' ? 'Checks failing' : tone === 'warn' ? 'Checks running' : 'Checks passing'
  const iconState = reportedTone === 'stop' || reportedTone === 'warn' || reportedTone === 'ok' ? reportedTone : undefined
  return { title: number === null ? SURFACE_META['pull-request'].label : `#${number}`, badge: <Tooltip label={label}><GitPresenceDot data-tone={reportedTone ?? 'ok'} tone={tone} /></Tooltip>, icon: <ShellElement as="span" shellRole="panel-pr-icon" state={iconState}><Icon glyph={IconGitPullRequest} role="label" /></ShellElement> }
}

function titleForSurface(surface: SurfaceKind, browserTitle: string, faviconUrl: string | null, prNumber: number | null, prTone: string | null, fileTitle: string, changed: number): { title: string; icon: React.ReactNode; badge?: React.ReactNode } {
  if (isBrowserSurface(surface) || surface === 'browser') return browserSurfaceTitle(browserTitle, faviconUrl)
  if (surface === 'diff') return { title: `Changes ${changed}`, icon: SURFACE_META.diff.icon }
  if (surface === 'files') return { title: fileTitle || SURFACE_META.files.label, icon: <PanelFilesIcon /> }
  if (surface === 'pull-request') return pullRequestSurfaceTitle(prNumber, prTone)
  const meta = SURFACE_META[isBrowserSurface(surface) ? 'browser' : surface]
  return { title: meta.label, icon: meta.icon }
}

function surfaceDisabledReason(
  surface: SurfaceKind,
  props: SidePanelProps,
  links: PullRequestLink[]
): string | undefined {
  if (surface === 'pull-request' && (props.isGitRepository === false || !props.dir)) {
    return 'Not a git repository'
  }
  if (surface === 'pull-request' && props.hasPullRequest === false) {
    return `No pull request for ${props.checkoutLabel ?? 'this branch'}`
  }
  if (surface === 'linked-pull-requests' && links.length === 0) {
    return 'No linked pull requests available.'
  }
  return undefined
}

function SidePanelHeader({
  openTabs,
  active,
  tabsRef,
  overflowing,
  dragTab,
  metaFor,
  selectSurface,
  closeSurface,
  reorderSurface,
  addOpen,
  setAddOpen,
  props,
  links,
  openSurface,
  icons,
  maximized,
  onToggleMaximize
}: {
  openTabs: SurfaceKind[]
  active: SurfaceKind | null
  tabsRef: React.RefObject<HTMLDivElement | null>
  overflowing: boolean
  dragTab: React.MutableRefObject<SurfaceKind | null>
  metaFor: (surface: SurfaceKind) => { title: string; icon: React.ReactNode; badge?: React.ReactNode }
  selectSurface: (surface: SurfaceKind) => void
  closeSurface: (surface: SurfaceKind) => void
  reorderSurface: (from: SurfaceKind, to: SurfaceKind) => void
  addOpen: boolean
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>
  props: SidePanelProps
  links: PullRequestLink[]
  openSurface: (surface: SurfaceKind) => void
  icons: Record<SurfaceKind, SurfaceMeta>
  maximized: boolean
  onToggleMaximize: () => void
}): React.JSX.Element {
  return (
    <ShellElement as="div" shellRole="panel-header">
      <ShellElement
        as="div"
        shellRole="panel-tabs"
        state={overflowing ? 'overflowing' : undefined}
        ref={tabsRef}
        role="tablist"
        aria-label="Panel surfaces"
        onMouseDownCapture={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
        onAuxClickCapture={(event) => {
          if (event.button === 1) event.preventDefault()
        }}
      >
        {openTabs.map((surface) => {
          const tab = metaFor(surface)
          return (
            <PanelTab
              key={surface}
              draggable
              label={tab.title}
              badge={tab.badge}
              ariaLabel={surface === 'pull-request' ? 'Pull request' : tab.title}
              icon={tab.icon}
              active={active === surface}
              onClick={() => selectSurface(surface)}
              onClose={() => closeSurface(surface)}
              onDragStart={() => {
                dragTab.current = surface
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                if (dragTab.current) reorderSurface(dragTab.current, surface)
                dragTab.current = null
              }}
              onDragEnd={() => {
                dragTab.current = null
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault()
                  closeSurface(surface)
                }
              }}
              onContextMenu={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
            />
          )
        })}
      </ShellElement>
      {openTabs.length > 0 && <Tooltip label="Open a surface">
        <ShellElement
          as="button"
          type="button"
          shellRole="panel-icon-button"
          aria-label="Open a surface"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((value) => !value)}
        >
          <Icon glyph={IconPlus} role="small" />
        </ShellElement>
      </Tooltip>}
      <ShellElement as="span" shellRole="panel-header-actions">
        <Tooltip label={maximized ? 'Restore panel' : 'Maximize panel'}>
          <ShellElement as="button" type="button" shellRole="panel-icon-button" aria-label={maximized ? 'Restore panel' : 'Maximize panel'} onClick={onToggleMaximize}>
            <Icon glyph={maximized ? IconMinimize : IconMaximize} role="small" />
          </ShellElement>
        </Tooltip>
      </ShellElement>
      {addOpen && (
        <ShellElement as="div" shellRole="panel-add-menu" role="menu" aria-label="Open a surface">
          {(['browser', 'files', 'diff', 'pull-request', 'linked-pull-requests'] as SurfaceKind[]).map(
            (surface) => {
              const meta = icons[surface]
              const disabledReason = surfaceDisabledReason(surface, props, links)
              const item = (
                <ShellElement
                  as="button"
                  key={surface}
                  type="button"
                  role="menuitem"
                  shellRole="panel-add-item"
                  state={disabledReason ? 'disabled' : undefined}
                  aria-disabled={Boolean(disabledReason) || undefined}
                  onClick={() => {
                    if (disabledReason) return
                    openSurface(surface)
                    setAddOpen(false)
                  }}
                >
                  <span aria-hidden="true">{meta.icon}</span>
                  <span>{meta.label}</span>
                  <ShellElement as="kbd" shellRole="panel-add-key">{meta.shortcut}</ShellElement>
                </ShellElement>
              )
              return disabledReason ? <Tooltip key={surface} label={disabledReason}>{item}</Tooltip> : item
            }
          )}
        </ShellElement>
      )}
    </ShellElement>
  )
}

function SidePanelLauncher({
  props,
  links,
  icons,
  openSurface
}: {
  props: SidePanelProps
  links: PullRequestLink[]
  icons: Record<SurfaceKind, SurfaceMeta>
  openSurface: (surface: SurfaceKind) => void
}): React.JSX.Element {
  return (
    <ShellElement as="div" shellRole="panel-launcher" tabIndex={0} aria-label="Open a surface">
      <ShellElement as="div" shellRole="panel-launcher-column">
        <ShellElement as="h2" shellRole="panel-launcher-title">Open a surface</ShellElement>
        <ShellElement as="div" shellRole="panel-launcher-rows">
          {(['browser', 'files', 'diff', 'pull-request', 'linked-pull-requests'] as SurfaceKind[]).map(
            (surface) => {
              const meta = icons[surface]
              const disabledReason = surfaceDisabledReason(surface, props, links)
              return (
                <LauncherRow
                  key={surface}
                  icon={meta.icon}
                  label={meta.label}
                  description={meta.description}
                  shortcut={meta.shortcut}
                  disabledReason={disabledReason}
                  onClick={() => {
                    if (!disabledReason) openSurface(surface)
                  }}
                />
              )
            }
          )}
        </ShellElement>
      </ShellElement>
    </ShellElement>
  )
}

function PanelContent({
  props,
  surface,
  active,
  isOrchestrator,
  filesRoot,
  setSurface,
  panelWidth,
  onBrowserTitleChange,
  onFilesTabTitleChange,
  checkAgentTargets,
  requestedPrForTab
}: {
  props: SidePanelProps
  surface: SurfaceKind
  active: boolean
  isOrchestrator: boolean
  filesRoot: string
  setSurface: (surface: SurfaceKind) => void
  panelWidth: number
  onBrowserTitleChange: (id: string, title: string, favicon: string | null) => void
  onFilesTabTitleChange: (name: string | null) => void
  checkAgentTargets: CheckAgentTarget[]
  requestedPrForTab: { number: number; nonce: number } | null
}): React.JSX.Element {
  const visible = Boolean(active && props.open !== false && !props.hiddenByOverlay && props.openTabs?.includes(surface))
  if (isBrowserSurface(surface) || surface === 'browser') {
    return (
      <ShellElement as="div" shellRole="panel-surface" hidden={!visible}>
        <Suspense fallback={<div className="flex-1" />}>
          <BrowserSurface
            workspace={props.workspace}
            tabId={surface.slice(8)}
            initialUrl={browserTabUrl(props.workspace, surface.slice(8))}
            onSendToTerminal={props.onSendToTerminal}
            active={visible}
            onTitleChange={(title, favicon) => onBrowserTitleChange(surface, title, favicon)}
            client={props.client ?? undefined}
            onFocusPane={props.onFocusPane}
          />
        </Suspense>
      </ShellElement>
    )
  }
  if (surface === 'files') {
    return (
      <ShellElement as="div" shellRole="panel-surface" hidden={!visible}>
        <Suspense fallback={<div className="flex-1" />}>
          <FilesSurface
            key={filesRoot}
            workspaceRoot={filesRoot}
            documentOwnerId={`side:${props.workspace}`}
            panelWidth={panelWidth}
            client={props.client}
            onActiveFileChange={onFilesTabTitleChange}
            onOpenInEditor={(path) => props.onMoveFile(filesRoot, path)}
            onSendPath={props.onSendToTerminal}
          />
        </Suspense>
      </ShellElement>
    )
  }
  if (surface === 'diff' || surface === 'pull-request') {
    return (
      <ShellElement as="div" shellRole="panel-surface" hidden={!visible}>
        <SourceControlPanel
          {...props}
          requestedPr={requestedPrForTab}
          key={`${props.dir ?? 'none'}:${surface}:${props.activeSessionId ?? 'none'}`}
          session={props.activeSessionId}
          tab={surface === 'diff' ? 'changes' : 'pull-request'}
          onTab={(tab) => setSurface(tab === 'changes' ? 'diff' : 'pull-request')}
          hideHeader
          embedded
          checkoutLabel={props.checkoutLabel}
          onSendToTerminal={props.onSendToTerminal}
          checkAgentTargets={checkAgentTargets}
          onOpenPane={props.onFocusPane}
          checkoutPanes={[...props.sessions.values()].map((session) => ({ id: session.id, path: session.worktree?.path ?? session.project_dir }))}
        />
      </ShellElement>
    )
  }
  if (surface === 'linked-pull-requests') {
    return (
      <ShellElement as="div" shellRole="panel-surface" hidden={!visible}>
        {props.linkedPullRequests?.length ? (
          <ShellElement as="div" shellRole="panel-linked-list">
            {props.linkedPullRequests.map((link) => (
              <ShellElement
                as="button"
                key={`${link.repository}:${link.number}`}
                type="button"
                shellRole="panel-linked-row"
                onClick={() => {
                  props.onSelectPullRequest?.(link)
                  setSurface('pull-request')
                }}
              >
                <Icon glyph={IconGitPullRequest} role="label" />
                <ShellElement as="span" shellRole="panel-linked-copy">
                  <ShellElement as="span" shellRole="panel-linked-title">
                    {link.title || `Pull request #${link.number}`}
                  </ShellElement>
                  <ShellElement as="span" shellRole="panel-linked-meta">
                    {link.repository} · #{link.number}
                  </ShellElement>
                </ShellElement>
              </ShellElement>
            ))}
          </ShellElement>
        ) : (
          <ShellElement as="div" shellRole="panel-empty">No linked pull requests for this grid.</ShellElement>
        )}
      </ShellElement>
    )
  }
  return (
    <ShellElement as="div" shellRole="panel-surface" hidden={!visible}>
      {isOrchestrator && props.client && props.activeSessionId != null && (
        <Suspense fallback={<div className="flex-1" />}>
          <OverviewTab
            parentId={props.activeSessionId}
            sessions={props.sessions}
            client={props.client}
            onClose={() => setSurface('diff')}
            onReview={(child) => {
              props.onReviewChild(child)
              setSurface('diff')
            }}
          />
        </Suspense>
      )}
    </ShellElement>
  )
}

function SidePanelBody({
  openTabs,
  active,
  props,
  links,
  icons,
  openSurface,
  isOrchestrator,
  filesRoot,
  setSurface,
  panelWidth,
  onBrowserTitleChange,
  onFilesTabTitleChange,
  checkAgentTargets,
  requestedPrForTab,
  overviewTarget,
  setOverviewTarget,
}: {
  openTabs: SurfaceKind[]
  active: SurfaceKind | null
  props: SidePanelProps
  links: PullRequestLink[]
  icons: Record<SurfaceKind, SurfaceMeta>
  openSurface: (surface: SurfaceKind) => void
  isOrchestrator: boolean
  filesRoot: string
  setSurface: (surface: SurfaceKind) => void
  panelWidth: number
  onBrowserTitleChange: (id: string, title: string, favicon: string | null) => void
  onFilesTabTitleChange: (name: string | null) => void
  checkAgentTargets: CheckAgentTarget[]
  requestedPrForTab: { number: number; nonce: number } | null
  overviewTarget: number | null
  setOverviewTarget: React.Dispatch<React.SetStateAction<number | null>>
}): React.JSX.Element {
  return (
    <ShellElement as="div" shellRole="panel-body">
      {openTabs.length === 0 ? (
        <SidePanelLauncher props={props} links={links} icons={icons} openSurface={openSurface} />
      ) : (
        openTabs.map((surface) => (
          <PanelContent
            key={surface}
            props={{ ...props, openTabs }}
            surface={surface}
            active={active === surface}
            isOrchestrator={isOrchestrator}
            filesRoot={filesRoot}
            setSurface={setSurface}
            panelWidth={panelWidth}
            onBrowserTitleChange={onBrowserTitleChange}
            onFilesTabTitleChange={onFilesTabTitleChange}
            checkAgentTargets={checkAgentTargets}
            requestedPrForTab={requestedPrForTab}
          />
        ))
      )}
      {overviewTarget !== null && isOrchestrator && props.client && (
        <ShellElement as="div" shellRole="panel-overview">
          <Suspense fallback={<div className="flex-1" />}>
            <OverviewTab
              parentId={overviewTarget}
              sessions={props.sessions}
              client={props.client}
              onClose={() => setOverviewTarget(null)}
              onReview={(child) => {
                props.onReviewChild(child)
                setOverviewTarget(null)
              }}
            />
          </Suspense>
        </ShellElement>
      )}
    </ShellElement>
  )
}

function SidePanelFrame({ open, entering, mounted, props, openTabs, active, tabsRef, overflowing, dragTab, metaFor, selectSurface, closeSurface, reorderSurface, addOpen, setAddOpen, links, openSurface, icons, rendered, requested, hostWidth, finishExit, onKeyDown, isOrchestrator, filesRoot, onTitleChange, onFilesTabTitleChange, checkAgentTargets, requestedPrForTab, overviewTarget, setOverviewTarget, setEntering, maximized, onToggleMaximize }: {
  open: boolean
  entering: boolean
  mounted: boolean
  props: SidePanelProps
  openTabs: SurfaceKind[]
  active: SurfaceKind | null
  tabsRef: React.RefObject<HTMLDivElement | null>
  overflowing: boolean
  dragTab: React.MutableRefObject<SurfaceKind | null>
  metaFor: (surface: SurfaceKind) => { title: string; icon: React.ReactNode; badge?: React.ReactNode }
  selectSurface: (surface: SurfaceKind) => void
  closeSurface: (surface: SurfaceKind) => void
  reorderSurface: (from: SurfaceKind, to: SurfaceKind) => void
  addOpen: boolean
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>
  links: PullRequestLink[]
  openSurface: (surface: SurfaceKind) => void
  icons: typeof SURFACE_META
  rendered: number
  requested: number
  hostWidth: number
  finishExit: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  isOrchestrator: boolean
  filesRoot: string
  onTitleChange: (id: string, title: string, favicon: string | null) => void
  onFilesTabTitleChange: (name: string | null) => void
  checkAgentTargets: CheckAgentTarget[]
  requestedPrForTab: { number: number; nonce: number } | null
  overviewTarget: number | null
  setOverviewTarget: React.Dispatch<React.SetStateAction<number | null>>
  setEntering: React.Dispatch<React.SetStateAction<boolean>>
  maximized: boolean
  onToggleMaximize: () => void
}): React.JSX.Element {
  return (
    <InspectorSurface
      aria-label="Pane inspector"
      data-testid="side-panel"
      data-proactive-diff-enabled={props.proactiveDiffEnabled === true ? 'true' : 'false'}
      data-state={!open ? 'closing' : entering ? 'entering' : 'open'}
      data-dir={props.dir ?? undefined}
      hiddenByOverlay={props.hiddenByOverlay}
      style={{ width: rendered, maxWidth: '100%', display: mounted ? undefined : 'none' }}
      inert={props.hiddenByOverlay || !open}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return
        if (open) setEntering(false)
        else {
          finishExit()
          props.onExitAnimationEnd?.()
        }
      }}
      onFocusCapture={props.onFocusSide}
      onPointerDownCapture={props.onFocusSide}
      onKeyDown={onKeyDown}
    >
      <ScmResizeHandle requested={requested} rendered={rendered} hostWidth={hostWidth} onWidth={props.onWidth} onReset={props.onResetWidth} />
      <SidePanelHeader openTabs={openTabs} active={active} tabsRef={tabsRef} overflowing={overflowing} dragTab={dragTab} metaFor={metaFor} selectSurface={selectSurface} closeSurface={closeSurface} reorderSurface={reorderSurface} addOpen={addOpen} setAddOpen={setAddOpen} props={props} links={links} openSurface={openSurface} icons={icons} maximized={maximized} onToggleMaximize={onToggleMaximize} />
      <SidePanelBody openTabs={openTabs} active={active} props={props} links={links} icons={icons} openSurface={openSurface} isOrchestrator={isOrchestrator} filesRoot={filesRoot} setSurface={selectSurface} panelWidth={rendered} onBrowserTitleChange={onTitleChange} onFilesTabTitleChange={onFilesTabTitleChange} checkAgentTargets={checkAgentTargets} requestedPrForTab={requestedPrForTab} overviewTarget={overviewTarget} setOverviewTarget={setOverviewTarget} />
    </InspectorSurface>
  )
}

export function SidePanel(props: SidePanelProps): React.JSX.Element | null {
  const open = props.open ?? true
  const { mounted, finishExit } = useExitAnimation(open, INSPECTOR_EXIT_MS)
  const wasOpen = useRef<boolean | null>(null)
  const [entering, setEntering] = useState(false)
  useLayoutEffect(() => {
    const opened = open && wasOpen.current === false
    wasOpen.current = open
    setEntering(opened)
    if (!opened) return
    const t = setTimeout(() => setEntering(false), INSPECTOR_EXIT_MS)
    return () => clearTimeout(t)
  }, [open])

  const [tabs, setTabs] = useState(() => loadInspectorTabs(props.workspace))
  const { openTabs, active } = tabs
  const [filesRoot, setFilesRoot] = useState(props.dir ?? props.workspace)
  const [hostWidth, setHostWidth] = useState(0)
  const [overflowing, setOverflowing] = useState(false)
  const [browserMeta, setBrowserMeta] = useState<Record<string, {title: string; favicon: string | null}>>({})
  const [filesTabTitle, setFilesTabTitle] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [overviewTarget, setOverviewTarget] = useState<number | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const actionCount = useRef(0)
  const requestedPrNonce = useRef(0)
  const dragTab = useRef<SurfaceKind | null>(null)
  const [lastFocusedId, setLastFocusedId] = useState(props.activeSessionId)
  if (props.activeSessionId != null && props.activeSessionId !== lastFocusedId) setLastFocusedId(props.activeSessionId)
  const subjectId = props.activeSessionId ?? lastFocusedId
  const focused = subjectId == null ? undefined : props.sessions.get(subjectId)
  const isOrchestrator = hasChildren(focused, props.sessions)
  const requested = localStorage.getItem('tr-scm-width') === null ? defaultScmWidth(window.innerWidth) : props.width
  const rendered = clampScmWidth(requested, hostWidth)
  const restoreWidth = useRef<number | null>(null)
  const maximized = restoreWidth.current !== null && rendered >= scmWidthMax(hostWidth)
  const onToggleMaximize = (): void => {
    if (restoreWidth.current !== null) {
      props.onWidth(restoreWidth.current)
      restoreWidth.current = null
    } else {
      restoreWidth.current = requested
      props.onWidth(scmWidthMax(hostWidth))
    }
  }
  const links = props.linkedPullRequests ?? []
  const checkAgentTargets = props.checkAgentTargets ?? gridCheckAgents(props.sessions, props.workspace)
  const requestedPrForTab = useMemo(
    () => props.requestedPr ? { number: props.requestedPr.number, nonce: ++requestedPrNonce.current } : null,
    [props.requestedPr]
  )

  useEffect(() => { saveInspectorTabs(props.workspace, tabs) }, [props.workspace, tabs])
  useEffect(() => {
    const restore = (): void => setTabs(loadInspectorTabs(props.workspace))
    restore()
    window.addEventListener('houston:inspector-restore', restore)
    return () => window.removeEventListener('houston:inspector-restore', restore)
  }, [props.workspace])
  useEffect(() => { setFilesRoot(props.dir ?? props.workspace) }, [props.dir, props.workspace])
  useEffect(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="side-panel-row"]')
    if (!host || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setHostWidth(host.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const node = tabsRef.current
    if (!node) return
    const update = (): void => setOverflowing(node.scrollWidth > node.clientWidth)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [openTabs, active, browserMeta, hostWidth])
  const recordAction = (): void => {
    actionCount.current += 1
    props.onUserActionCounterChange?.(actionCount.current)
  }
  const openSurface = (requested: SurfaceKind): void => {
    const surface: SurfaceKind = requested === 'browser' ? `browser:browser-${crypto.randomUUID()}` : requested
    setTabs((current) => ({ openTabs: current.openTabs.includes(surface) ? current.openTabs : [...current.openTabs, surface], active: surface }))
    recordAction()
  }
  useSidePanelRequest(props.request?.kind === 'browser' ? null : props.request, props.activeSessionId, isOrchestrator, setOverviewTarget, setFilesRoot, openSurface)
  useEffect(() => {
    const request = props.request
    if (request?.kind !== 'browser' || request.workspace !== props.workspace) return
    updateSideBrowser(request.id, request.url, props.workspace, request.action ?? 'open')
    setTabs(loadInspectorTabs(props.workspace))
    props.onBrowserRequestHandled?.(request)
  }, [props.request])
  useEffect(() => {
    if (isTauri() && isBrowserSurface(active)) void tauriBrowserInvoke('browser_set_active', {id: active.slice(8), workspaceId: props.workspace})
  }, [active, props.workspace])
  const closeSurface = (surface: SurfaceKind): void => {
    if (isBrowserSurface(surface)) localStorage.removeItem(`tr-inspector-browser-url:${props.workspace}:${surface.slice(8)}`)
    setTabs((current) => {
      const next = current.openTabs.filter((item) => item !== surface)
      return { openTabs: next, active: current.active === surface ? (next.at(-1) ?? null) : current.active }
    })
    recordAction()
  }
  const selectSurface = (surface: SurfaceKind): void => { setTabs((current) => ({ ...current, active: surface })); recordAction() }
  const reorderSurface = (from: SurfaceKind, to: SurfaceKind): void => {
    if (from === to) return
    setTabs((current) => {
      const list = [...current.openTabs]
      const source = list.indexOf(from)
      const target = list.indexOf(to)
      if (source < 0 || target < 0) return current
      list.splice(source, 1)
      list.splice(target, 0, from)
      return { ...current, openTabs: list }
    })
    recordAction()
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !(event.target as HTMLElement).closest('[role="dialog"], .ctx-menu')) { event.stopPropagation(); if (maximized) onToggleMaximize(); else props.onFocusGrid(); return }
    if (openTabs.length === 0 && 'bfdpl'.includes(event.key.toLowerCase()) && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
      const shortcut = Object.entries(SURFACE_META).find(([, item]) => item.shortcut.toLowerCase() === event.key.toLowerCase())
      if (shortcut && !surfaceDisabledReason(shortcut[0] as SurfaceKind, props, links)) {
        event.preventDefault()
        openSurface(shortcut[0] as SurfaceKind)
      }
    }
  }
  const onTitleChange = useCallback((id: string, title: string, favicon: string | null): void => { setBrowserMeta((current) => ({...current, [id]: {title, favicon}})) }, [])
  const onFilesTabTitleChange = useCallback((name: string | null): void => setFilesTabTitle(name ?? ''), [])
  const [changesSummary, setChangesSummary] = useState<ChangesSummary | null>(null)
  const onChangesSummary = useCallback((summary: ChangesSummary): void => { setChangesSummary(summary); props.onSummaryChange?.(summary) }, [props.onSummaryChange])
  const prLink = props.requestedPr ?? props.linkedPullRequests?.[0]
  const prTone = pullRequestTone(prLink)
  const metaFor = (surface: SurfaceKind): { title: string; icon: React.ReactNode; badge?: React.ReactNode } => titleForSurface(surface, browserMeta[surface]?.title ?? '', browserMeta[surface]?.favicon ?? null, prLink?.number ?? changesSummary?.prNumber ?? null, prTone ?? changesSummary?.prTone ?? null, filesTabTitle, changesSummary?.changed ?? 0)
  const icons = useMemo(() => ({ ...SURFACE_META }), [])
  const handledProactiveDiff = useRef<number | null>(null)
  useEffect(() => {
    const request = props.proactiveDiffRequest
    if (!request || request.id === handledProactiveDiff.current) return
    handledProactiveDiff.current = request.id
    if (props.proactiveDiffEnabled && request.hasDiff && request.userUntouched) {
      setTabs((current) => ({ openTabs: current.openTabs.includes('diff') ? current.openTabs : [...current.openTabs, 'diff'], active: 'diff' }))
    }
  }, [props.proactiveDiffEnabled, props.proactiveDiffRequest, props.onUserActionCounterChange])

  if (!mounted && !props.keepMounted && !openTabs.some(isBrowserSurface)) return null
  return <SidePanelFrame open={open} entering={entering} mounted={mounted} props={{ ...props, maximized, onSummaryChange: onChangesSummary }} openTabs={openTabs} active={active} tabsRef={tabsRef} overflowing={overflowing} dragTab={dragTab} metaFor={metaFor} selectSurface={selectSurface} closeSurface={closeSurface} reorderSurface={reorderSurface} addOpen={addOpen} setAddOpen={setAddOpen} links={links} openSurface={openSurface} icons={icons} rendered={rendered} requested={requested} hostWidth={hostWidth} finishExit={finishExit} onKeyDown={onKeyDown} isOrchestrator={isOrchestrator} filesRoot={filesRoot} onTitleChange={onTitleChange} onFilesTabTitleChange={onFilesTabTitleChange} checkAgentTargets={checkAgentTargets} requestedPrForTab={requestedPrForTab} overviewTarget={overviewTarget} setOverviewTarget={setOverviewTarget} setEntering={setEntering} maximized={maximized} onToggleMaximize={onToggleMaximize} />
}

export function SidePanelIntegration({ selectedWorkspace, activeId, sessions: sessionsProp, request, reviewChild, onSurface, onFocusPane, onRevealWorkspace, onOpenEditor, onReviewChild, ...props }: Omit<SourceControlPanelProps, 'onCreateCheckAgent' | 'requestedPr'> & {
  onCreateCheckAgent?: (provider: string, text: string) => Promise<number | null>
  requestedPr?: PullRequestLink | null
  selectedWorkspace: string
  workspaces?: { path: string; name: string }[]
  focused?: boolean
  open?: boolean
  keepMounted?: boolean
  onExitAnimationEnd?: () => void
  onSendToTerminal?: (text: string) => void
  sendToTerminalLabel?: string
  activeId: number | null
  sessions: ReadonlyMap<number, SessionInfo>
  request: SideOpen | null
  onBrowserRequestHandled?: (request: SideOpen) => void
  reviewChild: SessionInfo | null
  onSurface: (surface: 'grid' | 'side') => void
  onFocusPane: (id: number) => void
  onRevealWorkspace: (root: string) => void
  onOpenEditor: (root: string, path: string, anchor: null) => void
  onReviewChild: (child: SessionInfo) => void
  linkedPullRequests?: PullRequestLink[]
  onSelectPullRequest?: (link: PullRequestLink) => void
  proactiveDiffEnabled?: boolean
  proactiveDiffRequest?: { id: number; hasDiff: boolean; userUntouched: boolean }
  isGitRepository?: boolean
  hasPullRequest?: boolean
  browserTabId?: string
  onUserActionCounterChange?: (count: number) => void
}): React.JSX.Element {
  const workspace = selectedWorkspace === 'all' ? sessionsProp.get(activeId ?? -1)?.project_dir ?? 'all' : selectedWorkspace
  const checkoutIdentity = (sessionsProp.get(activeId ?? -1) as (SessionInfo & { checkout?: Parameters<typeof formatCheckout>[0] }) | undefined)?.checkout
  const checkout = formatCheckout(checkoutIdentity).text
  return (
    <SidePanel
      {...props}
      key={workspace}
      workspace={workspace}
      sessions={sessionsProp}
      request={request}
      activeSessionId={activeId}
      reviewTarget={reviewChild?.id}
      onReviewChild={onReviewChild}
      checkoutLabel={checkout}
      onFocusPane={onFocusPane}
      onFocusSide={() => onSurface('side')}
      onFocusGrid={() => {
        onSurface('grid')
        if (activeId !== null) {
          onFocusPane(activeId)
          selectOverviewChild(activeId, null)
        }
      }}
      onMoveFile={(root, path) => {
        onRevealWorkspace(root)
        onOpenEditor(root, path, null)
        onSurface('grid')
      }}
    />
  )
}

// Hidden workspace browsers retain their native surface identity until their tab closes.
export function SidePanelWorkspaces(props: Parameters<typeof SidePanelIntegration>[0]): React.JSX.Element {
  const workspaces = Array.from(new Set([props.selectedWorkspace, ...(props.workspaces ?? []).map((workspace) => workspace.path)]))
    .filter((workspace) => workspace === props.selectedWorkspace || loadInspectorTabs(workspace).openTabs.some(isBrowserSurface))
  return <>{workspaces.map((workspace) => <WorkspaceSidePanel key={workspace} workspace={workspace} {...props} />)}</>
}

function WorkspaceSidePanel({ workspace, ...props }: Parameters<typeof SidePanelIntegration>[0] & {workspace: string}): React.JSX.Element {
  const selected = workspace === props.selectedWorkspace
  const request = props.request?.kind === 'browser'
    ? (props.request.workspace === workspace ? props.request : null)
    : (selected ? props.request : null)
  return (
    <div className={selected ? 'flex min-w-0' : 'hidden'}>
      <SidePanelIntegration {...props}
        selectedWorkspace={workspace}
        proactiveDiffEnabled={selected && props.proactiveDiffEnabled}
        focused={selected && props.focused}
        open={selected && props.open !== false}
        keepMounted={loadInspectorTabs(workspace).openTabs.some(isBrowserSurface)}
        request={request}
        reviewChild={selected ? props.reviewChild : null}
        dir={selected ? props.dir : workspace}
        hiddenByOverlay={!selected || props.hiddenByOverlay}
      />
    </div>
  )
}
