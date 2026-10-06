import { PaneFrame } from './ui/PaneFrame'
import { useSession, useSessionFamily } from '../sessionsStore'
import { openSideOverview, SIDE_SELECT_EVENT } from '../sidePanel'
import { memo, useEffect, useContext, useRef, useState } from 'react'
import { ChildrenRoster, ChildStatusDot, delegationAge, PEEK_KEEP_MOUNTED } from './ChildrenRoster'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { WarmContext } from '../layout/warmContext'
import type {
  AgentKind,
  AgentStatus,
  HoustonClient,
  SessionInfo
} from '../houston/client'
import { isLive } from '../houston/client'
import { showItemInFolder } from '../houston/bridge'
import type { ThemeName } from '../theme'
import type { SplitSide } from '../layout/tree'
import { TerminalPane, type RegisterOutput, type TermActions } from '../pane/TerminalPane'
import { DictationIndicator } from '../voice/DictationIndicator'
import { AnimOut, MenuLayer } from './ui/AnimOut'
import {
  RestartConfirm,
  ResumeNotice,
  restartEntries,
  restartTooltip,
  type RestartMode
} from './PaneRestart'
import type { HandoffSource } from './PaneHandoff'
import { clampConversation } from './handoffPacket'
import { RenameTitle } from './RenameTitle'
import { Tooltip } from './ui/Tooltip'
import {
  AGENT_DOT_COLOR,
  IconAgent,
  IconArrowUpRight,
  IconClose,
  IconCopy,
  IconEllipsis,
  IconEraser,
  IconFolder,
  IconGitBranch,
  IconMaximize,
  IconMinimize,
  IconPlus,
  IconRespawn,
  IconSplitDown,
  IconSplitRight,
  IconStopCircle,
  IconSwap,
  IconTextLarger,
  IconTextSmaller,
  type IconComponent
} from './icons'
import { usePaneFocusTier } from '../windowFocus'
import { PaneHeader } from './ui'
import {
  PaneBranchChip,
  PaneEngineGlyph,
  PaneHeadActions,
  PaneHeadButton,
  PaneHeadIdentity,
  PaneStateChip,
  PaneStatusDot,
  PaneSubtitle,
  PaneHeadBadge
} from './ui/PaneControls'
import {
  ChildrenColumn,
  PeekBarButton,
  PeekBarIconButton,
  SettledChildButton,
  SettledChildFooter
} from './ui/ChildPaneLayout'
import { PaneContextMenu, PaneContextMenuChord, PaneContextMenuHead, PaneContextMenuRow, PaneContextMenuRowLabel, PaneContextMenuSeparator } from './ui/PaneContextMenu'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import { PaneHeaderTags, PaneTagMenu } from './PaneTags'
import {
  effectiveLabel,
  fontZoomIn,
  fontZoomOut,
  movePaneNext,
  movePanePrev,
  splitDown,
  splitRight
} from '../keymap'
import { ICON_ROLE_CLS, Icon } from './ui/Icon'
import { HeaderDelegationBadge, type PaneRoster } from './DelegationCard'
import {
  endedLabel,
  isGridSession,
  recentAfterSelection,
  rosterChildren,
  rosterSessions,
  visiblePeek,
  withSessionFamily
} from './sessionPaneSubscriptions'
import { popOriginStyle } from './ui/overlayChrome'
import { usePaneContextMenu } from './paneContextMenu'
import { ContextIndicator } from './ContextIndicator'
import { PaneTaskChip } from './tasks/PaneTaskChip'
import { PrWatchChip } from './ui/PrWatch'
import { usePrWatch } from './git/usePrWatch'
import { Button } from './ui/Button'
import { RosterPeekbar, RosterSplit } from './ui/RosterSurface'
import { Count } from './ui/Count'

export const HEAD_ICON_CLS = ICON_ROLE_CLS.ui

export const HANDOFF_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok'] as const
export type HandoffProvider = (typeof HANDOFF_PROVIDERS)[number]
export { endedLabel }

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

function CtxRow({
  glyph,
  label,
  chord,
  tone = 'normal',
  disabled = false,
  disabledReason,
  onClick
}: {
  glyph: IconComponent
  label: string
  chord?: string
  tone?: 'normal' | 'danger'
  disabled?: boolean
  disabledReason?: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip label={disabled ? disabledReason : undefined}>
      <PaneContextMenuRow tone={tone} disabled={disabled} onClick={onClick}>
        <PaneContextMenuRowLabel>
          <Icon glyph={glyph} role="ui" />
          {label}
        </PaneContextMenuRowLabel>
        {chord !== undefined && <PaneContextMenuChord>{chord}</PaneContextMenuChord>}
      </PaneContextMenuRow>
    </Tooltip>
  )
}

function collapseHome(path: string): string {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

export function engineGlyphColor(agent: AgentKind): string {
  return AGENT_DOT_COLOR[agent] ?? 'var(--text-muted)'
}

function statusLabel(s: AgentStatus): string {
  switch (s) {
    case 'spawning':
      return 'starting…'
    case 'working':
      return 'working'
    case 'idle':
      return 'ready'
    case 'needs-input':
      return 'needs your input'
    case 'unavailable':
      return 'status unavailable'
  }
}

export function StatusDot({
  status,
  live
}: {
  status: AgentStatus | null | undefined
  live: boolean
}): React.JSX.Element | null {
  if (!live || !status) return null
  return (
    <Tooltip label={statusLabel(status)}>
      <PaneStatusDot status={status} role="img" aria-label={statusLabel(status)} />
    </Tooltip>
  )
}

export function OriginBadge({
  info,
  roster,
  onFocusPane,
  onDeliverNow
}: {
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  onDeliverNow?: (session: number) => void
}): React.JSX.Element {
  return (
    <HeaderDelegationBadge
      kind="origin"
      info={info}
      roster={roster}
      onFocusPane={onFocusPane}
      onDeliverNow={onDeliverNow}
    />
  )
}

export function AcpBadge({ slug }: { slug: string }): React.JSX.Element {
  return (
    <Tooltip label={`ACP mode (${slug}) — status comes from this CLI's own protocol stream, not hooks`}>
      <PaneHeadBadge
        data-testid="acp-badge"
        aria-label={`ACP mode: ${slug}`}
      >
        acp
      </PaneHeadBadge>
    </Tooltip>
  )
}

export function OrchestratorBadge({
  info,
  roster,
  onFocusPane
}: {
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
}): React.JSX.Element {
  return (
    <HeaderDelegationBadge
      kind="orchestrator"
      info={info}
      roster={roster}
      onFocusPane={onFocusPane}
    />
  )
}

// The branch a pane's cwd is on, once git has answered for it. No answer means
// no chip, never a placeholder; the tooltip gives the full name on hover and on
// keyboard focus, plus a quiet note naming the panes that share the checkout.
export function BranchChip({
  branch,
  note
}: {
  branch?: string | null
  note?: string | null
}): React.JSX.Element | null {
  if (branch == null || branch === '') return null
  const label = note ? `${branch}\n${note}` : branch
  return (
    <Tooltip label={label}>
      <PaneBranchChip
        type="button"
        data-testid="branch-chip"
        aria-label={`Branch ${branch}`}
        className="[@container_(max-width:400px)]:hidden"
      >
        <Icon glyph={IconGitBranch} role="small" />
        <span className="truncate">{branch}</span>
      </PaneBranchChip>
    </Tooltip>
  )
}

export function ProfileBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <Tooltip label={`Running as account profile "${label}"`}>
      <PaneHeadBadge
        data-testid="profile-badge"
        aria-label={`Account profile: ${label}`}
      >
        {label}
      </PaneHeadBadge>
    </Tooltip>
  )
}

interface Props {
  client: HoustonClient
  info: SessionInfo
  theme: ThemeName
  active: boolean
  connected: boolean
  fontSize: number
  fontFamily?: string
  shiftEnterNewline?: boolean
  openLinksInPane?: boolean
  onOpenUrlInPane?: (url: string) => void
  copyOnSelect: boolean
  stripBoxGlyphs: boolean
  showProject: boolean
  /** The branch this pane's cwd is on, once git has answered; absent hides the chip. */
  branch?: string | null
  /** A quiet note for the chip's tooltip: who else shares the checkout or repository. */
  branchNote?: string | null
  registerOutput: RegisterOutput
  shellIntegration: boolean
  onReconnectSsh: (id: number) => void
  onActivate: (id: number) => void
  expanded?: boolean
  onExpand: (id: number) => void
  onZoom: (dir: 1 | -1 | 0) => void
  onShellZoom: (dir: 1 | -1 | 0) => void
  onSplit: (id: number, side: SplitSide) => void
  onAddPane?: (anchor: number, rect: DOMRect) => void
  onHeaderPointerDown: (id: number, e: React.PointerEvent) => void
  onHandoff: (source: HandoffSource) => void
  onSwapAdjacent?: (id: number, offset: 1 | -1) => void
  onOpenFile: (id: number, path: string, line?: number, col?: number) => void
  onOpenDir: (path: string, session?: number) => void
  gridSessionIds?: ReadonlySet<number>
  onMoveChildToGrid?: (parent: number, child: number) => void
  onReturnChildToRoster?: (child: number) => void
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
}

function PaneWatchChip({ watches }: { watches: readonly { number: number }[] }): React.JSX.Element | null {
  return watches[0] ? <PrWatchChip number={watches[0].number} /> : null
}

function SessionPaneImpl({
  client,
  info: infoProp,
  theme,
  active,
  connected,
  fontSize,
  fontFamily,
  shiftEnterNewline,
  openLinksInPane,
  onOpenUrlInPane,
  copyOnSelect,
  stripBoxGlyphs,
  showProject,
  branch,
  branchNote,
  registerOutput,
  shellIntegration,
  onReconnectSsh,
  onActivate,
  expanded = false,
  onExpand,
  onZoom,
  onShellZoom,
  onSplit,
  onAddPane,
  onHeaderPointerDown,
  onHandoff,
  onSwapAdjacent,
  onOpenFile,
  onOpenDir,
  roster: rosterProp,
  gridSessionIds,
  onMoveChildToGrid,
  onReturnChildToRoster,
  onFocusPane
}: Props): React.JSX.Element {
  const info = useSession(infoProp.id, infoProp) ?? infoProp
  const prWatches = usePrWatch(client, info.id)
  const family = useSessionFamily(info.id, rosterSessions(rosterProp))
  const roster = withSessionFamily(rosterProp, family)
  const [peekId, setPeekId] = useState<number | null>(null)
  const [recent, setRecent] = useState<number[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const children = rosterChildren(roster?.sessions, info.id)
  const peek = visiblePeek(children, peekId, gridSessionIds)
  const selectChild = (id: number | null): void => {
    if (isGridSession(id, gridSessionIds)) {
      onFocusPane?.(id)
      return
    }
    setPeekId(id)
    if (id != null) setRecent((prev) => recentAfterSelection(prev, id, PEEK_KEEP_MOUNTED))
  }
  const moveChild = (id: number): void => {
    if (isGridSession(id, gridSessionIds)) {
      onFocusPane?.(id)
      return
    }
    setPeekId(null)
    setRecent((prev) => prev.filter((other) => other !== id))
    onMoveChildToGrid?.(info.id, id)
  }
  const live = isLive(info.state)
  const ended = endedLabel(info.state)

  const focusTier = usePaneFocusTier(active)

  const keymapOverrides = useContext(KeymapOverridesContext)
  const [confirmRestart, setConfirmRestart] = useState<RestartMode | null>(null)
  const termActions = useRef<TermActions | null>(null)
  const [menuCwd, setMenuCwd] = useState<string | null>(null)

  const cwd = menuCwd ?? info.cwd
  useEffect(() => {
    const select = (event: Event): void => {
      const { parent, child } = (event as CustomEvent<{ parent: number; child: number | null }>).detail
      if (parent !== info.id) return
      onActivate(info.id)
      selectChild(child)
    }
    window.addEventListener(SIDE_SELECT_EVENT, select)
    return () => window.removeEventListener(SIDE_SELECT_EVENT, select)
  }, [info.id, onActivate, selectChild])

  const menuSideEffects = (): void => {
    setMenuCwd(null)
    client.sessionCwd(info.id).then(setMenuCwd, () => setMenuCwd(info.cwd))
  }
  const { menu, openMenuAt, openMenuAtButton, closeMenu, menuItem, menuRef } =
    usePaneContextMenu(menuSideEffects)

  const glyphAgent: AgentKind = info.detected_agent ?? info.agent
  return (
    <PaneFrame
      kind="session"
      focusTier={focusTier}
      active={active}
      dimmed={Boolean(ended)}
      data-panekey={info.id}
      onPointerDownCapture={() => onActivate(info.id)}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.pane-head')) return
        e.preventDefault()
        openMenuAt(e.clientX, e.clientY)
      }}
    >
      <PaneHeader
        data-pane-focus-head={focusTier}
        divider="solid"
        transition="background"
        dragCursor
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button, input, [data-pane-head-control]')) return
          onHeaderPointerDown(info.id, e)
        }}
      >
        <PaneHeadIdentity>
          <SessionHeaderStatusDot info={info} live={live} />
          <Tooltip label={`${glyphAgent} session`}>
            <PaneEngineGlyph
              data-testid="engine-glyph"
              aria-label={`${glyphAgent} session`}
              className="[@container_(max-width:360px)]:hidden"
              style={{ color: engineGlyphColor(glyphAgent) }}
            >
              <IconAgent agent={glyphAgent} className={ICON_ROLE_CLS.ui} />
            </PaneEngineGlyph>
          </Tooltip>
          <RenameTitle
            title={info.title}
            onRename={(t) => client.renameSession(info.id, t)}
          />
          <PaneTaskChip task={info.task} />
          <PaneWatchChip watches={prWatches} />
          <BranchChip branch={branch} note={branchNote} />
          <PaneHeaderTags tagIds={info.tags} />
          {info.acp != null && <AcpBadge slug={info.acp} />}
          {info.profile_label != null && <ProfileBadge label={info.profile_label} />}
          {showProject && (
            <PaneSubtitle data-testid="pane-sub" className="[@container_(max-width:400px)]:hidden">
              · {info.agent === 'ssh' && info.ssh_host ? info.ssh_host : basename(info.project_dir)}
            </PaneSubtitle>
          )}
        </PaneHeadIdentity>
        <SessionInboxButton info={info} />
        <SessionHeaderActions info={info} client={client} ended={ended} live={live} expanded={expanded} shellIntegration={shellIntegration} onReconnectSsh={onReconnectSsh} onExpand={onExpand} onAddPane={onAddPane} menuOpen={menu !== null} closeMenu={closeMenu} openMenuAtButton={openMenuAtButton} />
      </PaneHeader>
      <ResumeNotice notice={info.resume_notice} />
      <ChildrenRoom info={info} children={children} roster={roster} client={client} peek={peek} selectChild={selectChild} moveChild={moveChild} collapsed={collapsed} onCollapse={() => setCollapsed(!collapsed)} terminals={<RosterTerminals client={client} info={info} children={children} recent={recent} gridSessionIds={gridSessionIds} peek={peek} active={active} connected={connected} theme={theme} fontSize={fontSize} fontFamily={fontFamily} shiftEnterNewline={shiftEnterNewline} openLinksInPane={openLinksInPane} onOpenUrlInPane={onOpenUrlInPane} copyOnSelect={copyOnSelect} stripBoxGlyphs={stripBoxGlyphs} registerOutput={registerOutput} onActivate={onActivate} onZoom={onZoom} onShellZoom={onShellZoom} onOpenFile={onOpenFile} onOpenDir={onOpenDir} termActions={termActions} />} />
      <AnimOut open={confirmRestart !== null} suppress="modal">
        {confirmRestart && (
          <RestartConfirm
            mode={confirmRestart}
            info={info}
            client={client}
            shellIntegration={shellIntegration}
            onClose={() => setConfirmRestart(null)}
          />
        )}
      </AnimOut>
      <MenuLayer open={menu !== null} onClose={closeMenu} suppress="popover" menuRef={menuRef}>
        {menu && (
        <PaneContextMenu
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          style={{ left: menu.x, right: menu.right, top: menu.y, ...popOriginStyle(menu.originX, menu.originY) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <PaneContextMenuHead heading={info.title} detail={collapseHome(cwd)} />
          <PaneContextMenuSeparator />
          {children.length > 0 && <CtxRow glyph={IconFolder} label="Overview" onClick={menuItem(() => openSideOverview(info.id))} />}
          {info.spawned_by != null && onReturnChildToRoster && <CtxRow glyph={IconArrowUpRight} label="Return to roster" onClick={menuItem(() => onReturnChildToRoster(info.id))} />}
          <CtxRow
            glyph={IconSplitRight}
            label="Split right"
            chord={effectiveLabel(splitRight, keymapOverrides)}
            onClick={menuItem(() => onSplit(info.id, 'right'))}
          />
          <CtxRow
            glyph={IconSplitDown}
            label="Split down"
            chord={effectiveLabel(splitDown, keymapOverrides)}
            onClick={menuItem(() => onSplit(info.id, 'bottom'))}
          />
          <CtxRow
            glyph={IconSwap}
            label="Swap with previous pane"
            chord={effectiveLabel(movePanePrev, keymapOverrides)}
            disabled={onSwapAdjacent === undefined}
            disabledReason="This grid holds one pane — nothing to swap with"
            onClick={menuItem(() => onSwapAdjacent?.(info.id, -1))}
          />
          <CtxRow
            glyph={IconSwap}
            label="Swap with next pane"
            chord={effectiveLabel(movePaneNext, keymapOverrides)}
            disabled={onSwapAdjacent === undefined}
            disabledReason="This grid holds one pane — nothing to swap with"
            onClick={menuItem(() => onSwapAdjacent?.(info.id, 1))}
          />
          <PaneContextMenuSeparator />
          <CtxRow
            glyph={IconTextLarger}
            label="Bigger text"
            chord={effectiveLabel(fontZoomIn, keymapOverrides)}
            onClick={menuItem(() => onZoom(1))}
          />
          <CtxRow
            glyph={IconTextSmaller}
            label="Smaller text"
            chord={effectiveLabel(fontZoomOut, keymapOverrides)}
            onClick={menuItem(() => onZoom(-1))}
          />
          <CtxRow
            glyph={IconArrowUpRight}
            label="Handoff…"
            onClick={menuItem(() =>
              onHandoff({
                session: info.id,
                agent: glyphAgent,
                title: info.title,
                cwd,
                conversation: clampConversation(termActions.current?.readOutput('all') ?? '')
              })
            )}
          />
          <PaneContextMenuSeparator />
          <CtxRow
            glyph={IconEraser}
            label="Clear screen"
            onClick={menuItem(() => termActions.current?.clear())}
          />
          <CtxRow
            glyph={IconStopCircle}
            label="Interrupt"
            chord="Ctrl+C"
            disabled={!live}
            disabledReason={`This pane is ${info.state} — there is nothing running to interrupt`}
            onClick={menuItem(() => {
              if (!client.sendStdin(info.id, '\x03')) {
                termActions.current?.toast('Interrupt was not delivered', 'connection lost', 'danger')
              }
            })}
          />
          {restartEntries({
            info,
            live,
            client,
            shellIntegration,
            confirm: setConfirmRestart,
            reconnect: () => onReconnectSsh(info.id)
          }).map((entry) => (
            <CtxRow
              key={entry.label}
              glyph={entry.glyph}
              label={entry.label}
              onClick={menuItem(entry.run)}
            />
          ))}
          <PaneContextMenuSeparator />
          <CtxRow
            glyph={IconFolder}
            label="Reveal in file manager"
            onClick={menuItem(() => {
              void showItemInFolder(cwd).then((res) => {
                if (!res.ok) termActions.current?.toast(res.error)
              })
            })}
          />
          <CtxRow
            glyph={IconCopy}
            label="Copy path"
            onClick={menuItem(() => void navigator.clipboard.writeText(cwd))}
          />
          <PaneTagMenu tagIds={info.tags} onChange={(tags) => client.setSessionTags(info.id, tags)} />
          <PaneContextMenuSeparator />
          <CtxRow
            glyph={IconClose}
            label={live ? 'Close pane (stops the agent)' : 'Close pane'}
            tone="danger"
            onClick={menuItem(() => client.closeSession(info.id))}
          />
        </PaneContextMenu>
        )}
      </MenuLayer>
    </PaneFrame>
  )
}

export const SessionPane = memo(SessionPaneImpl)

function RosterTerminals({ client, info, children, recent, gridSessionIds, peek, active, connected, theme, fontSize, fontFamily, shiftEnterNewline, openLinksInPane, onOpenUrlInPane, copyOnSelect, stripBoxGlyphs, registerOutput, onActivate, onZoom, onShellZoom, onOpenFile, onOpenDir, termActions }: Pick<Props, 'client' | 'info' | 'gridSessionIds' | 'active' | 'connected' | 'theme' | 'fontSize' | 'fontFamily' | 'shiftEnterNewline' | 'openLinksInPane' | 'onOpenUrlInPane' | 'copyOnSelect' | 'stripBoxGlyphs' | 'registerOutput' | 'onActivate' | 'onZoom' | 'onShellZoom' | 'onOpenFile' | 'onOpenDir'> & {
  children: SessionInfo[]
  recent: number[]
  peek: SessionInfo | undefined
  termActions: React.RefObject<TermActions | null>
}): React.JSX.Element {
  const gridHidden = useContext(GridHiddenContext)
  const gridWarm = useContext(WarmContext)
  return <>{[info, ...recent.flatMap((id) => {
              const child = children.find((item) => item.id === id)
              return child && !gridSessionIds?.has(id) ? [child] : []
            })].map((shown) => {
              const hidden = shown.id !== (peek?.id ?? info.id)
              return <div key={shown.id} data-peek-session={shown.id} className="absolute inset-0 flex min-w-0 min-h-0" aria-hidden={hidden} style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}>
                <GridHiddenContext.Provider value={gridHidden || hidden}>
                  <WarmContext.Provider value={gridWarm || hidden}>
                    <TerminalPane client={client} info={shown} theme={theme} active={active && !hidden} connected={connected} fontSize={fontSize} fontFamily={fontFamily} shiftEnterNewline={shiftEnterNewline} openLinksInPane={openLinksInPane} onOpenUrlInPane={onOpenUrlInPane} copyOnSelect={copyOnSelect} stripBoxGlyphs={stripBoxGlyphs} registerOutput={registerOutput} onActivate={() => onActivate(info.id)} onZoom={onZoom} onShellZoom={onShellZoom} onOpenFile={(path, line, col) => onOpenFile(shown.id, path, line, col)} onOpenDir={(path) => onOpenDir(path, shown.id)} actions={shown.id === info.id ? termActions : undefined} />
                  </WarmContext.Provider>
                </GridHiddenContext.Provider>
              </div>
            })}</>
}

function SessionHeaderStatusDot({ info, live }: { info: SessionInfo; live: boolean }): React.JSX.Element {
  if (info.spawned_by != null) return <ChildStatusDot info={info} />
  return <StatusDot status={info.children_waiting > 0 ? 'needs-input' : info.status} live={live || info.children_waiting > 0} />
}

function SessionInboxButton({ info }: { info: SessionInfo }): React.JSX.Element | null {
  if (!(info.inbox_unread > 0)) return null
  const label = `${info.inbox_unread} unread inbox messages`
  return <Tooltip label={label}><Button variant="ghost" size="sm" aria-label={label} className="flex-none" onClick={() => openSideOverview(info.id)}>Inbox<Count value={info.inbox_unread} /></Button></Tooltip>
}

function SessionHeaderActions({ info, client, ended, live, expanded, shellIntegration, onReconnectSsh, onExpand, onAddPane, menuOpen, closeMenu, openMenuAtButton }: Pick<Props, 'info' | 'client' | 'expanded' | 'shellIntegration' | 'onReconnectSsh' | 'onExpand' | 'onAddPane'> & {
  ended: string | null
  live: boolean
  menuOpen: boolean
  closeMenu: () => void
  openMenuAtButton: (rect: DOMRect) => void
}): React.JSX.Element {
  return (<PaneHeadActions>
          <ContextIndicator context={info.context} />
          {ended && (
            <PaneStateChip data-testid="pane-state" className="[@container_(max-width:490px)]:hidden" state={info.state}>
              {ended}
            </PaneStateChip>
          )}
          {!live && (
            <Tooltip
              label={restartTooltip(info)}
            >
              <PaneHeadButton
                aria-label={info.agent === 'ssh' ? 'Reconnect' : 'Restart'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (info.agent === 'ssh') onReconnectSsh(info.id)
                  else client.respawnSession(info.id, shellIntegration)
                }}
              >
                <Icon glyph={IconRespawn} role="ui" />
              </PaneHeadButton>
            </Tooltip>
          )}
          <Tooltip label="Terminal actions">
            <PaneHeadButton
              tone="accent"
              aria-label="Terminal actions"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                if (menuOpen) {
                  closeMenu()
                } else {
                  openMenuAtButton(e.currentTarget.getBoundingClientRect())
                }
              }}
            >
              <IconEllipsis className={HEAD_ICON_CLS} />
            </PaneHeadButton>
          </Tooltip>
          <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
            <PaneHeadButton
              tone={expanded ? 'info' : 'regular'}
              className="[@container_(max-width:150px)]:hidden"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-pressed={expanded}
              onClick={(e) => {
                e.stopPropagation()
                onExpand(info.id)
              }}
            >
              {expanded ? <IconMinimize className={HEAD_ICON_CLS} /> : <IconMaximize className={HEAD_ICON_CLS} />}
            </PaneHeadButton>
          </Tooltip>
          {onAddPane && (
            <Tooltip label="New pane">
              <PaneHeadButton
                tone="accent"
                aria-label="New pane"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddPane(info.id, e.currentTarget.getBoundingClientRect())
                }}
              >
                <IconPlus className={HEAD_ICON_CLS} />
              </PaneHeadButton>
            </Tooltip>
          )}
          <Tooltip label={live ? 'Close (stops the agent)' : 'Close'}>
            <PaneHeadButton
              tone="danger"
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation()
                client.closeSession(info.id)
              }}
            >
              <Icon glyph={IconClose} role="ui" />
            </PaneHeadButton>
          </Tooltip>
        </PaneHeadActions>)
}

function ChildrenRoom({ info, children, roster, client, peek, selectChild, moveChild, collapsed, onCollapse, terminals }: Pick<Props, 'info' | 'roster' | 'client'> & {
  children: SessionInfo[]
  peek: SessionInfo | undefined
  selectChild: (id: number | null) => void
  moveChild: (id: number) => void
  collapsed: boolean
  onCollapse: () => void
  terminals: React.ReactNode
}): React.JSX.Element {
  return (<><RosterSplit collapsed={collapsed}>
        {children.length > 0 && <ChildrenRoster parent={info} children={children} roster={roster} client={client} selected={peek?.id ?? null} onSelect={selectChild} onMove={moveChild} collapsed={collapsed} onCollapse={onCollapse} />}
        <ChildrenColumn>
          {peek && <RosterPeekbar>
            <PeekBarButton onClick={() => selectChild(null)}>Orchestrator</PeekBarButton><span>/</span><strong className="truncate min-w-0">{peek.delegation?.role ?? peek.title}</strong>
            <span className="flex-1" /><PeekBarButton shrink onClick={() => moveChild(peek.id)}>Move to grid</PeekBarButton>
            <Tooltip label="Return to orchestrator"><PeekBarIconButton aria-label="Return to orchestrator" onClick={() => selectChild(null)}><Icon glyph={IconClose} role="ui" /></PeekBarIconButton></Tooltip>
          </RosterPeekbar>}
          <div className="relative flex-1 min-h-0 min-w-0">
            {terminals}
          </div>
          {peek && !isLive(peek.state) && <SettledChildBar info={peek} client={client} onMove={moveChild} />}
        </ChildrenColumn>
      </RosterSplit>
      <DictationIndicator session={info.id} /></>)
}

function SettledChildBar({ info, client, onMove }: { info: SessionInfo; client: HoustonClient; onMove: (id: number) => void }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    // Settlement ages share the roster's second resolution.
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const ended = info.delegation?.ended_at ?? info.delegation?.settled_at
  const retained = info.delegation?.retained_until
  const time = (value: number): string => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return <SettledChildFooter>
    <span className="flex-1 min-w-0">Settled · ended {ended == null ? 'unknown' : `${time(ended)} (${delegationAge(ended, now)} ago)`} · kept until {retained == null ? 'unknown' : new Date(retained).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
    <SettledChildButton disabled={!info.resumable} onClick={() => client.respawnSession(info.id, undefined, null, undefined, undefined, false)}>Continue</SettledChildButton>
    <SettledChildButton onClick={() => client.closeSession(info.id)}>Close</SettledChildButton>
    <SettledChildButton onClick={() => onMove(info.id)}>Move to grid</SettledChildButton>
  </SettledChildFooter>
}
