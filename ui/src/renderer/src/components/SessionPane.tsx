import { useSession, useSessionFamily } from '../sessionsStore'
import { openSideOverview, SIDE_SELECT_EVENT } from '../sidePanel'
import { memo, useEffect, useContext, useRef, useState } from 'react'
import { ChildrenRoster, ChildStatusDot, delegationAge, PEEK_KEEP_MOUNTED } from './ChildrenRoster'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { WarmContext } from '../layout/warmContext'
import { RING_ACCENT_ICON } from './ui/shadowChrome'
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
import { BTN_GHOST, BTN_ICO_STRUCTURE } from './ui/buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { usePaneFocusTier } from '../windowFocus'
import { PaneHeader } from './ui'
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
import { HEAD_BADGE_CLS } from './headBadge'
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
import { POP_ORIGIN_CLS, popOriginStyle } from './ui/overlayChrome'
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

const CTX_MENU_CLS =
  `ctx-menu fixed z-[var(--z-overlay)] min-w-[180px] flex flex-col p-1 bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] motion-safe:animate-[menu-in_var(--animate-t-panel)_var(--animate-ease-menu)] [.anim-out_&]:motion-safe:animate-[menu-out_var(--animate-t-fast)_var(--animate-ease-menu)_forwards] ${POP_ORIGIN_CLS}`

const CTX_ITEM_CLS =
  'ctx-item border-none flex items-center justify-between gap-[14px] w-full py-[5px] px-2.5 rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
const CTX_ITEM_DANGER_CLS =
  'ctx-item border-none flex items-center justify-between gap-[14px] w-full py-[5px] px-2.5 rounded-[var(--tr-radius-input)] bg-transparent text-[var(--text-secondary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] text-left hover:bg-[var(--card-hover)] hover:text-[var(--danger)] disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]'
const CTX_SEP_CLS = 'ctx-sep h-px bg-[var(--border)] my-1 mx-1.5 flex-none'

const CTX_HEAD_CLS = 'flex flex-col gap-px px-2.5 pt-1.5 pb-1 min-w-0 max-w-[260px]'

const CTX_CHORD_CLS =
  'text-[var(--text-faint)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]'

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
      <button
        className={`btn ${tone === 'danger' ? CTX_ITEM_DANGER_CLS : CTX_ITEM_CLS}`}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="flex items-center gap-2">
          <Icon glyph={glyph} role="ui" />
          {label}
        </span>
        {chord !== undefined && <span className={CTX_CHORD_CLS}>{chord}</span>}
      </button>
    </Tooltip>
  )
}

function collapseHome(path: string): string {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~')
}

const ICO_HEAD_BASE =
  `${CONTROL_SIZE_SQUARE_CLS.mini} rounded-[var(--tr-radius-sm)] [transition:background_0.16s_cubic-bezier(0.4,0,0.2,1),color_0.16s_ease,transform_0.18s_cubic-bezier(0.34,1.56,0.64,1)] hover:-translate-y-px active:translate-y-0 active:scale-90 focus-visible:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] focus-visible:text-[var(--text-primary)] focus-visible:shadow-[${RING_ACCENT_ICON}] focus-visible:outline-none [@container_(max-width:280px)]:w-5 [@container_(max-width:280px)]:h-5 [@container_(max-width:200px)]:w-[18px] [@container_(max-width:200px)]:h-[18px] [body:has(.pane.focus)_.pane:not(.focus)_&]:text-[color-mix(in_srgb,var(--text-muted)_92%,var(--text-primary))]`
const ICO_HEAD_REGULAR =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--text-primary)_11%,transparent)] hover:text-[var(--text-primary)]'
const ICO_HEAD_ACCENT =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] hover:text-[color-mix(in_srgb,var(--accent)_75%,var(--text-primary))]'
const ICO_HEAD_DANGER =
  'bg-transparent text-[color-mix(in_srgb,var(--text-muted)_55%,var(--text-primary))] hover:bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] hover:text-[var(--danger)]'
const ICO_HEAD_INFO =
  'bg-[color-mix(in_srgb,var(--info)_16%,transparent)] text-[var(--info)] hover:bg-[color-mix(in_srgb,var(--info)_16%,transparent)] hover:text-[var(--info)]'

const ICO_HEAD_HIDE_150 = '[@container_(max-width:150px)]:hidden'

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

function statusDotClass(status: AgentStatus): string {
  const pulse = 'loop-anim [--dot-pulse-opacity:0.35] motion-safe:animate-[dot-pulse_1.4s_steps(4,end)_infinite]'
  switch (status) {
    case 'working':
      return `bg-[var(--info)] ${pulse}`
    case 'spawning':
      return `bg-[var(--accent)] ${pulse}`
    case 'idle':
      return 'bg-[var(--text-muted)]'
    case 'needs-input':
      return 'bg-[var(--warn)]'
    case 'unavailable':
      return 'bg-transparent ring-1 ring-inset ring-[var(--text-faint)]'
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
      <span
        className={`agent-dot w-[7px] h-[7px] rounded-full flex-none ${statusDotClass(status)}`}
        role="img"
        aria-label={statusLabel(status)}
      />
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
      <span
        data-testid="acp-badge"
        className={HEAD_BADGE_CLS}
        aria-label={`ACP mode: ${slug}`}
      >
        acp
      </span>
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
      <button
        type="button"
        data-testid="branch-chip"
        aria-label={`Branch ${branch}`}
        className="[@container_(max-width:400px)]:hidden inline-flex items-center gap-[var(--space-1-5)] min-w-0 flex-none max-w-[180px] px-[var(--space-1-5)] h-[var(--h-tag-chip)] rounded-[var(--tr-radius-sm)] border-0 bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] text-[var(--text-secondary)] font-mono [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] cursor-default"
      >
        <Icon glyph={IconGitBranch} role="small" />
        <span className="truncate">{branch}</span>
      </button>
    </Tooltip>
  )
}

export function ProfileBadge({ label }: { label: string }): React.JSX.Element {
  return (
    <Tooltip label={`Running as account profile "${label}"`}>
      <span
        data-testid="profile-badge"
        className={HEAD_BADGE_CLS}
        aria-label={`Account profile: ${label}`}
      >
        {label}
      </span>
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
    <section
      data-pane-focus-border={focusTier}
      className={`pane flex-1 min-w-0 min-h-0 relative flex flex-col bg-[var(--terminal-frame-bg)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] overflow-hidden ${ended ? 'opacity-80' : ''} ${active ? 'focus' : ''}`}
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
        <span
          data-testid="head-identity"
          className="head-identity inline-flex items-center gap-2 min-w-0 overflow-hidden [flex:0_1_auto]"
        >
          <SessionHeaderStatusDot info={info} live={live} />
          <Tooltip label={`${glyphAgent} session`}>
            <span
              data-testid="engine-glyph"
              aria-label={`${glyphAgent} session`}
              className="[@container_(max-width:360px)]:hidden inline-flex items-center justify-center w-4 h-4 flex-none"
              style={{ color: engineGlyphColor(glyphAgent) }}
            >
              <IconAgent agent={glyphAgent} className={ICON_ROLE_CLS.ui} />
            </span>
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
            <span
              data-testid="pane-sub"
              className="[@container_(max-width:400px)]:hidden text-[var(--text-faint)] text-[length:var(--tr-text-xs)] whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
            >
              · {info.agent === 'ssh' && info.ssh_host ? info.ssh_host : basename(info.project_dir)}
            </span>
          )}
        </span>
        <SessionInboxButton info={info} />
        <SessionHeaderActions info={info} client={client} ended={ended} live={live} expanded={expanded} shellIntegration={shellIntegration} onReconnectSsh={onReconnectSsh} onExpand={onExpand} onAddPane={onAddPane} menuOpen={menu !== null} closeMenu={closeMenu} openMenuAtButton={openMenuAtButton} />
      </PaneHeader>
      <ResumeNotice
        notice={info.resume_notice}
        buttonClassName={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_REGULAR}`}
      />
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
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          className={CTX_MENU_CLS}
          style={{ left: menu.x, right: menu.right, top: menu.y, ...popOriginStyle(menu.originX, menu.originY) }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className={CTX_HEAD_CLS} data-testid="pane-menu-head">
            <span className="min-w-0 truncate [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-primary)]">
              {info.title}
            </span>
            <span className="min-w-0 truncate [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] text-[var(--text-faint)]">
              {collapseHome(cwd)}
            </span>
          </div>
          <div className={CTX_SEP_CLS} />
          {children.length > 0 && <CtxRow glyph={IconFolder} label="Overview" onClick={menuItem(() => openSideOverview(info.id))} />}
          {info.spawned_by != null && onReturnChildToRoster && <CtxRow glyph={IconArrowUpRight} label="Return to roster" onClick={menuItem(() => onReturnChildToRoster(info.id))} />}
          <CtxRow
            glyph={IconSplitRight}
            label="Split Right"
            chord={effectiveLabel(splitRight, keymapOverrides)}
            onClick={menuItem(() => onSplit(info.id, 'right'))}
          />
          <CtxRow
            glyph={IconSplitDown}
            label="Split Down"
            chord={effectiveLabel(splitDown, keymapOverrides)}
            onClick={menuItem(() => onSplit(info.id, 'bottom'))}
          />
          <CtxRow
            glyph={IconSwap}
            label="Swap with Previous Pane"
            chord={effectiveLabel(movePanePrev, keymapOverrides)}
            disabled={onSwapAdjacent === undefined}
            disabledReason="This grid holds one pane — nothing to swap with"
            onClick={menuItem(() => onSwapAdjacent?.(info.id, -1))}
          />
          <CtxRow
            glyph={IconSwap}
            label="Swap with Next Pane"
            chord={effectiveLabel(movePaneNext, keymapOverrides)}
            disabled={onSwapAdjacent === undefined}
            disabledReason="This grid holds one pane — nothing to swap with"
            onClick={menuItem(() => onSwapAdjacent?.(info.id, 1))}
          />
          <div className={CTX_SEP_CLS} />
          <CtxRow
            glyph={IconTextLarger}
            label="Bigger Text"
            chord={effectiveLabel(fontZoomIn, keymapOverrides)}
            onClick={menuItem(() => onZoom(1))}
          />
          <CtxRow
            glyph={IconTextSmaller}
            label="Smaller Text"
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
          <div className={CTX_SEP_CLS} />
          <CtxRow
            glyph={IconEraser}
            label="Clear Screen"
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
          <div className={CTX_SEP_CLS} />
          <CtxRow
            glyph={IconFolder}
            label="Reveal in File Manager"
            onClick={menuItem(() => {
              void showItemInFolder(cwd).then((res) => {
                if (!res.ok) termActions.current?.toast(res.error)
              })
            })}
          />
          <CtxRow
            glyph={IconCopy}
            label="Copy Path"
            onClick={menuItem(() => void navigator.clipboard.writeText(cwd))}
          />
          <PaneTagMenu
            tagIds={info.tags}
            onChange={(tags) => client.setSessionTags(info.id, tags)}
            itemCls={CTX_ITEM_CLS}
            sepCls={CTX_SEP_CLS}
          />
          <div className={CTX_SEP_CLS} />
          <CtxRow
            glyph={IconClose}
            label={live ? 'Close Pane (stops the agent)' : 'Close Pane'}
            tone="danger"
            onClick={menuItem(() => client.closeSession(info.id))}
          />
        </div>
        )}
      </MenuLayer>
    </section>
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
  return (<span className="head-actions ml-auto flex items-center gap-px flex-none">
          <ContextIndicator context={info.context} />
          {ended && (
            <span
              data-testid="pane-state"
              className={`[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] [text-transform:var(--tr-text-label-transform)] rounded-full py-px px-2 flex-none [@container_(max-width:490px)]:hidden ${info.state === 'exited' ? 'text-[var(--status-done-text)] bg-[var(--status-done-bg)]' : 'text-[var(--status-blocked-text)] bg-[var(--status-blocked-bg)]'}`}
            >
              {ended}
            </span>
          )}
          {!live && (
            <Tooltip
              label={restartTooltip(info)}
            >
              <button
                className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_REGULAR}`}
                aria-label={info.agent === 'ssh' ? 'Reconnect' : 'Restart'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (info.agent === 'ssh') onReconnectSsh(info.id)
                  else client.respawnSession(info.id, shellIntegration)
                }}
              >
                <Icon glyph={IconRespawn} role="ui" />
              </button>
            </Tooltip>
          )}
          <Tooltip label="Terminal actions">
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_ACCENT}`}
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
            </button>
          </Tooltip>
          <Tooltip label={expanded ? 'Collapse (z)' : 'Expand (z)'}>
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${expanded ? ICO_HEAD_INFO : ICO_HEAD_REGULAR} ${ICO_HEAD_HIDE_150}`}
              aria-label={expanded ? 'Collapse' : 'Expand'}
              aria-pressed={expanded}
              onClick={(e) => {
                e.stopPropagation()
                onExpand(info.id)
              }}
            >
              {expanded ? <IconMinimize className={HEAD_ICON_CLS} /> : <IconMaximize className={HEAD_ICON_CLS} />}
            </button>
          </Tooltip>
          {onAddPane && (
            <Tooltip label="New pane">
              <button
                className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_ACCENT}`}
                aria-label="New pane"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddPane(info.id, e.currentTarget.getBoundingClientRect())
                }}
              >
                <IconPlus className={HEAD_ICON_CLS} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={live ? 'Close (stops the agent)' : 'Close'}>
            <button
              className={`${BTN_ICO_STRUCTURE} ${ICO_HEAD_BASE} ${ICO_HEAD_DANGER}`}
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation()
                client.closeSession(info.id)
              }}
            >
              <Icon glyph={IconClose} role="ui" />
            </button>
          </Tooltip>
        </span>)
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
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {peek && <RosterPeekbar>
            <button className="btn border-none bg-transparent min-h-7 truncate" onClick={() => selectChild(null)}>Orchestrator</button><span>/</span><strong className="truncate min-w-0">{peek.delegation?.role ?? peek.title}</strong>
            <span className="flex-1" /><button className="btn border-none bg-transparent min-h-7 shrink-0" onClick={() => moveChild(peek.id)}>Move to grid</button>
            <Tooltip label="Return to orchestrator"><button className={BTN_ICO_STRUCTURE + ' min-w-7 min-h-7'} aria-label="Return to orchestrator" onClick={() => selectChild(null)}><Icon glyph={IconClose} role="ui" /></button></Tooltip>
          </RosterPeekbar>}
          <div className="relative flex-1 min-h-0 min-w-0">
            {terminals}
          </div>
          {peek && !isLive(peek.state) && <SettledChildBar info={peek} client={client} onMove={moveChild} />}
        </div>
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
  const button = `${BTN_GHOST} btn min-h-[var(--h-ctl)] shrink-0`
  return <footer aria-label="Settled child" className="flex items-center flex-wrap gap-1 px-2 py-1 border-t border-[var(--divider)] bg-[var(--card-bg)] text-[length:var(--tr-text-sm)] text-[var(--text-muted)]">
    <span className="flex-1 min-w-0">Settled · ended {ended == null ? 'unknown' : `${time(ended)} (${delegationAge(ended, now)} ago)`} · kept until {retained == null ? 'unknown' : new Date(retained).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
    <button className={button} disabled={!info.resumable} onClick={() => client.respawnSession(info.id, undefined, null, undefined, undefined, false)}>Continue</button>
    <button className={button} onClick={() => client.closeSession(info.id)}>Close</button>
    <button className={button} onClick={() => onMove(info.id)}>Move to grid</button>
  </footer>
}
