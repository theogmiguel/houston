import { ConfirmModal } from './ConfirmModal'
import { IconPencil } from './icons'
import { GLYPH_FOR_VERB } from './verbGlyphs'
import { ChildInputBanner } from './ChildInputDetails'
import { askedOrchestrator, attentionStatus, needsUserInput } from '../sessionAttention'
import { PaneFrame } from './ui/PaneFrame'
import { shallowArrayEqual, useSession, useSessionFamily, useSessionsSelector } from '../sessionsStore'
import { hasWorkingDescendant } from './ui/railRows'
import { TERMINAL_FOCUS_EVENT, openSideOverview, SIDE_SELECT_EVENT } from '../sidePanel'
import { memo, useCallback, useEffect, useContext, useRef, useState } from 'react'
import { ChildrenRoster, ChildStatusDot, delegationAge, PEEK_KEEP_MOUNTED } from './ChildrenRoster'
import { GridHiddenContext } from '../layout/gridHiddenContext'
import { WarmContext } from '../layout/warmContext'
import type {
  AgentKind,
  AgentStatus,
  HoustonClient,
  KeymapOverrides,
  SessionInfo
} from '../houston/client'
import { isLive } from '../houston/client'
import { showItemInFolder } from '../houston/bridge'
import type { ThemeName } from '../theme'
import type { SplitSide } from '../layout/tree'
import { TerminalPane, type RegisterOutput, type TermActions } from '../pane/TerminalPane'
import { preloadable } from '../preloadable'
import { useRosterMode } from '../pane/rosterMode'
import { DictationIndicator } from '../voice/DictationIndicator'
import { AnimOut, MenuLayer } from './ui/AnimOut'
import {
  RecoveryFooter,
  RestartConfirm,
  isRestoreHusk,
  paneDimming,
  restartEntries,
  restartTooltip,
  type RestartMode
} from './PaneRestart'
import type { HandoffSource } from './PaneHandoff'
import { clampConversation } from './handoffPacket'
import { collapseHome } from './recoveryReason'
import { errorSessionIds } from '../houston/paneOps'
import { PaneOpsContext, usePaneOpState } from '../houston/paneOpsContext'
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
  IconMaximize,
  IconMinimize,
  IconMoon,
  IconPlus,
  IconRespawn,
  IconSplitDown,
  IconSplitRight,
  IconStopCircle,
  IconGitBranch,
  IconSwap,
  IconTextLarger,
  IconTextSmaller,
  type IconComponent
} from './icons'
import { usePaneFocusTier } from '../windowFocus'
import { Button, Card, Inline, Inset, Notice, PaneHeader, StatusLabel, Text } from './ui'
import {
  PaneEngineGlyph,
  PaneHeadActions,
  PaneHeadButton,
  PaneHeadIdentity,
  PaneStateChip,
  PaneStatusDot,
  PaneSubtitle,
  PaneHeadBadge,
  PaneNotice
} from './ui/PaneControls'
import {
  ChildrenColumn,
  PeekTerminalLayer,
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
import { RosterPeekbar, RosterSplit, type RosterMode } from './ui/RosterSurface'
import { Count } from './ui/Count'
import { ShellBranchCopyChip, ShellElement } from './ui/ShellPrimitives'
import { formatCheckout } from './checkout/formatCheckout'
import { WorktreeChildrenPopover } from './WorktreeChildrenPopover'
import type { SessionCheckout } from '../houston/generated/SessionCheckout'
import type { PaneContextMenu as PaneContextMenuController } from './paneContextMenu'

export const HEAD_ICON_CLS = ICON_ROLE_CLS.ui

export const HANDOFF_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'zcode'] as const
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

type CheckoutOf = SessionInfo & { checkout?: SessionCheckout | null }

const noWorktreeChildren: SessionInfo[] = []

// Live children working in a worktree other than this pane's own checkout.
function useWorktreeChildren(info: SessionInfo): SessionInfo[] {
  const root = (info as CheckoutOf).checkout?.root
  return useSessionsSelector(
    useCallback((sessions) => [...sessions.values()].filter((child) => {
      const checkout = (child as CheckoutOf).checkout
      return child.spawned_by === info.id && isLive(child.state) && checkout?.root !== root && formatCheckout(checkout).kind === 'worktree'
    }), [info.id, root]),
    shallowArrayEqual,
    noWorktreeChildren
  )
}

export function BranchChip({
  checkout,
  remoteHost,
  worktreeChildren = noWorktreeChildren,
  onFocusChild
}: {
  checkout?: SessionCheckout | null
  remoteHost?: string | null
  worktreeChildren?: readonly SessionInfo[]
  onFocusChild?: (id: number) => void
}): React.JSX.Element | null {
  const formatted = formatCheckout(checkout, { remoteHost: remoteHost ?? undefined })
  const countRef = useRef<HTMLButtonElement | null>(null)
  const [childrenOpen, setChildrenOpen] = useState(false)
  const closeChildren = useCallback(() => setChildrenOpen(false), [])
  const popoverOpen = childrenOpen && worktreeChildren.length > 0
  if (formatted.kind === 'unknown') return null
  const detail = formatted.kind === 'remote' ? remoteHost : formatted.branch
  const revealWorktree = (event: React.MouseEvent<HTMLSpanElement>): void => {
    if (!event.ctrlKey || formatted.kind !== 'worktree' || !checkout) return
    event.preventDefault()
    event.stopPropagation()
    void showItemInFolder(checkout.root)
  }
  return (
    <>
      <span data-testid="branch-chip" className="inline-flex items-center gap-[var(--space-1)] [@container_(max-width:400px)]:hidden" onClickCapture={revealWorktree}>
        <Tooltip label={formatted.kind === 'worktree' && checkout ? `${formatted.text}\n${checkout.root}` : formatted.text}>
          <ShellBranchCopyChip value={formatted.branch ?? checkout?.head ?? formatted.badge}>
            <span className="inline-flex min-w-0 items-center gap-[var(--space-1)] truncate">
              <span>{formatted.kind === 'remote' ? 'remote' : formatted.badge}</span>
              {detail && <><span> </span><ShellElement as="span" shellRole="pane-branch-detail-separator">·</ShellElement><span> </span><span className="truncate">{detail}</span></>}
            </span>
          </ShellBranchCopyChip>
        </Tooltip>
        {worktreeChildren.length > 0 && (
          <Button
            variant="badge"
            ref={countRef}
            aria-label={`${worktreeChildren.length} child worktrees`}
            aria-haspopup="dialog"
            aria-expanded={popoverOpen}
            onClick={() => setChildrenOpen((open) => !open)}
          >
            <ShellElement as="span" shellRole="pane-branch-children">
              <Icon glyph={IconGitBranch} role="label" />
              <span data-testid="branch-chip-children">{worktreeChildren.length}</span>
            </ShellElement>
          </Button>
        )}
      </span>
      {popoverOpen && (
        <WorktreeChildrenPopover
          checkout={checkout}
          childSessions={worktreeChildren}
          anchorRef={countRef}
          onFocusChild={(id) => onFocusChild?.(id)}
          onClose={closeChildren}
        />
      )}
    </>
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
  branch?: string | null
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
  paneId?: string
  gridSessionIds?: ReadonlySet<number>
  onMoveChildToGrid?: (parent: number, child: number) => void
  onReturnChildToRoster?: (child: number) => void
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
}

function PaneWatchChip({ watches }: { watches: readonly { number: number }[] }): React.JSX.Element | null {
  return watches[0] ? <PrWatchChip number={watches[0].number} /> : null
}

interface SessionMemoryResult {
  bytes: number | null
  measuredAt: number | null
  reason: string | null
}

function isSessionLifecycleError(message: { context?: string | null; message: string }, sessionId: number): boolean {
  return errorSessionIds(message).includes(sessionId)
}

function useSessionLifecycle(client: HoustonClient, sessionId: number): {
  memoryResult: SessionMemoryResult | null
  setMemoryResult: React.Dispatch<React.SetStateAction<SessionMemoryResult | null>>
  lifecycleError: string | null
  dismissLifecycleError: () => void
  showLifecycleError: (message: string) => void
} {
  const [memoryResult, setMemoryResult] = useState<SessionMemoryResult | null>(null)
  const [lifecycleError, setLifecycleError] = useState<string | null>(null)
  const ops = useContext(PaneOpsContext)

  useEffect(() => {
    setMemoryResult(null)
    setLifecycleError(null)
  }, [sessionId])

  useEffect(() => {
    const offMemory = client.subscribe('session_memory', (message) => {
      if (message.session === sessionId) {
        setMemoryResult({ bytes: message.bytes ?? null, measuredAt: message.measured_at_ms ?? null, reason: message.unavailable_reason ?? null })
      }
    })
    const offError = client.subscribe('error', (message) => {
      // A refused close or respawn belongs to PaneOps, which shows it once.
      if (isSessionLifecycleError(message, sessionId) && ops.attribute(message) === null) setLifecycleError(message.message)
    })
    return () => { offMemory(); offError() }
  }, [client, ops, sessionId])

  const dismissLifecycleError = useCallback(() => setLifecycleError(null), [])
  return { memoryResult, setMemoryResult, lifecycleError, dismissLifecycleError, showLifecycleError: setLifecycleError }
}

function SessionLifecycleNotices({ info, lifecycleError, dismissLifecycleError, memoryResult }: {
  info: SessionInfo
  lifecycleError: string | null
  dismissLifecycleError: () => void
  memoryResult: SessionMemoryResult | null
}): React.JSX.Element {
  const { error, clearError: dismissPaneError } = usePaneOpState(info.id)
  const paneError = isRestoreHusk(info, isLive(info.state)) ? null : error
  return <>
    {info.sleep_notice && <PaneNotice data-testid="session-recovery-notice">{info.sleep_notice}</PaneNotice>}
    {paneError && <Notice tone="danger" inset="compact-inline" className="flex-none" action={{ label: 'Dismiss', onClick: dismissPaneError }}>{paneError}</Notice>}
    {lifecycleError && <Notice tone="danger" inset="compact-inline" className="flex-none" action={{ label: 'Dismiss', onClick: dismissLifecycleError }}>{lifecycleError}</Notice>}
    {memoryResult && <div role="status"><Notice tone="info" inset="compact-inline" className="flex-none">
      {memoryResult.bytes == null ? memoryResult.reason ?? 'Memory measurement is unavailable.' : `Process memory (PSS): ${formatMemory(memoryResult.bytes)}`}
      {memoryResult.measuredAt != null && <span> · measured {new Date(memoryResult.measuredAt).toLocaleTimeString()}</span>}
    </Notice></div>}
  </>
}

function SessionLifecycleMenuItems({
  info,
  live,
  sleeping,
  shellIntegration,
  client,
  menuItem,
  setMemoryResult,
}: {
  info: SessionInfo
  live: boolean
  sleeping: boolean
  shellIntegration: boolean
  client: HoustonClient
  menuItem: PaneContextMenuController['menuItem']
  setMemoryResult: React.Dispatch<React.SetStateAction<SessionMemoryResult | null>>
}): React.JSX.Element {
  return <>
    {info.spawned_by == null && (info.agent === 'claude' || info.agent === 'codex') && !info.task && !sleeping && live && (
      <CtxRow glyph={IconMoon} label="Sleep session" disabled={info.status !== 'idle'} disabledReason="Sleep requires this agent to be idle" onClick={menuItem(() => client.send({ type: 'session_sleep', session: info.id }))} />
    )}
    {sleeping && <>
      <CtxRow glyph={IconRespawn} label="Wake conversation" onClick={menuItem(() => client.send({ type: 'session_wake', session: info.id }))} />
      <CtxRow glyph={IconRespawn} label="Start fresh conversation" onClick={menuItem(() => client.respawnSession(info.id, shellIntegration, undefined, undefined, undefined, true))} />
    </>}
    {!sleeping && <CtxRow glyph={GLYPH_FOR_VERB['measure-memory']} label="Measure process memory" onClick={menuItem(() => {
      setMemoryResult(null)
      client.send({ type: 'session_memory_get', session: info.id })
    })} />}
  </>
}

function GenerateTitleConfirm({ open, info, onCancel, onConfirm }: {
  open: boolean
  info: SessionInfo
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return <AnimOut open={open} suppress="modal">
    {open && <ConfirmModal destructive={false} title="Generate title" confirmLabel="Generate title" message={`Send up to 1 KB of redacted first-prompt and first-reply hook text through this pane’s ${info.detected_agent ?? info.agent} account to generate a title? This may use provider quota. Houston reads no transcript or scrollback. Providers without verified tools-off controls are refused.`} onCancel={onCancel} onConfirm={onConfirm} />}
  </AnimOut>
}

// A thread pane's timeline, Markdown and tool cards load only when a thread is shown.
const threadPane = preloadable(() => import('./thread/ThreadPane').then((module) => module.ThreadPane))

/** Terminal text size and a handoff built from scrollback; a thread has neither yet, so Handoff is refused by name. */
function TextAndHandoffRows({ thread, keymapOverrides, menuItem, onZoom, onHandoff }: {
  thread: boolean
  keymapOverrides: KeymapOverrides
  menuItem: PaneContextMenuController['menuItem']
  onZoom: (dir: 1 | -1 | 0) => void
  onHandoff: () => void
}): React.JSX.Element {
  return <>
    {!thread && <>
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
    </>}
    <CtxRow
      glyph={IconArrowUpRight}
      label="Handoff…"
      disabled={thread}
      disabledReason="Handoff from a thread is not available yet; it reads terminal scrollback"
      onClick={menuItem(onHandoff)}
    />
  </>
}

/** A thread stops its turn; a terminal clears its screen or sends Ctrl+C. */
function InterruptRows({ info, live, client, menuItem, termActions }: {
  info: SessionInfo
  live: boolean
  client: HoustonClient
  menuItem: PaneContextMenuController['menuItem']
  termActions: React.RefObject<TermActions | null>
}): React.JSX.Element {
  if (info.view === 'thread') {
    const turn = info.status === 'working' || info.status === 'spawning' || info.status === 'needs-input'
    return <CtxRow glyph={IconStopCircle} label="Stop" disabled={!turn} disabledReason="Claude is not working on a turn" onClick={menuItem(() => client.send({ type: 'thread_stop', session: info.id }))} />
  }
  return <>
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
  </>
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
  paneId,
  onMoveChildToGrid,
  onReturnChildToRoster,
  onFocusPane
}: Props): React.JSX.Element {
  const info = useSession(infoProp.id, infoProp) ?? infoProp
  const prWatches = usePrWatch(client, info.id)
  const worktreeChildren = useWorktreeChildren(info)
  const family = useSessionFamily(info.id, rosterSessions(rosterProp))
  const roster = withSessionFamily(rosterProp, family)
  const [peekId, setPeekId] = useState<number | null>(null)
  const [recent, setRecent] = useState<number[]>([])
  const [rosterMode, setRosterMode] = useRosterMode(paneId, info)
  const children = rosterChildren(roster?.sessions, info.id)
  const peek = visiblePeek(children, peekId, gridSessionIds)
  const selectChild = (id: number | null): void => {
    if (isGridSession(id, gridSessionIds)) {
      onFocusPane?.(id)
      return
    }
    setPeekId(id)
    window.dispatchEvent(new CustomEvent(TERMINAL_FOCUS_EVENT, { detail: { session: id ?? info.id } }))
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
  const [confirmGenerateTitle, setConfirmGenerateTitle] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState<RestartMode | null>(null)
  const termActions = useRef<TermActions | null>(null)
  const [menuCwd, setMenuCwd] = useState<string | null>(null)
  const { memoryResult, setMemoryResult, lifecycleError, dismissLifecycleError, showLifecycleError } = useSessionLifecycle(client, infoProp.id)

  const lifecycleInfo = info
  const sleeping = info.state === 'sleeping'

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
      dimmed={paneDimming(info, live, ended)}
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
            titleSource={info.title_source}
            onReset={() => client.resetSessionTitle(info.id)}
          />
          <PaneTaskChip task={info.task} />
          <PaneWatchChip watches={prWatches} />
          <BranchChip checkout={(info as CheckoutOf).checkout} remoteHost={info.ssh_host} worktreeChildren={worktreeChildren} onFocusChild={selectChild} />
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
      <ChildInputBanner info={info} client={client} />
      <SessionLifecycleNotices info={lifecycleInfo} lifecycleError={lifecycleError} dismissLifecycleError={dismissLifecycleError} memoryResult={memoryResult} />
      {sleeping ? <SleepingSessionPlaceholder info={lifecycleInfo} onWake={() => client.send({ type: 'session_wake', session: info.id })} onFresh={() => client.respawnSession(info.id, shellIntegration, undefined, undefined, undefined, true)} /> : <ChildrenRoom info={info} children={children} roster={roster} client={client} peek={peek} selectChild={selectChild} moveChild={moveChild} mode={rosterMode} onMode={setRosterMode} terminals={<RosterTerminals client={client} info={info} children={children} recent={recent} gridSessionIds={gridSessionIds} peek={peek} active={active} connected={connected} theme={theme} fontSize={fontSize} fontFamily={fontFamily} shiftEnterNewline={shiftEnterNewline} openLinksInPane={openLinksInPane} onOpenUrlInPane={onOpenUrlInPane} copyOnSelect={copyOnSelect} stripBoxGlyphs={stripBoxGlyphs} registerOutput={registerOutput} onActivate={onActivate} onZoom={onZoom} onShellZoom={onShellZoom} onOpenFile={onOpenFile} onOpenDir={onOpenDir} termActions={termActions} />} />}
      <RecoveryFooter info={info} live={live} client={client} shellIntegration={shellIntegration} onReconnectSsh={onReconnectSsh} />
      <GenerateTitleConfirm open={confirmGenerateTitle} info={info} onCancel={() => setConfirmGenerateTitle(false)} onConfirm={() => { setConfirmGenerateTitle(false); client.send({ type: 'session_title_generate', session: info.id }) }} />
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
          {lifecycleError && <Notice tone="danger" action={{ label: 'Dismiss', onClick: dismissLifecycleError }}>{lifecycleError}</Notice>}
          <SessionLifecycleMenuItems info={info} live={live} sleeping={sleeping} shellIntegration={shellIntegration} client={client} menuItem={menuItem} setMemoryResult={setMemoryResult} />
          <PaneContextMenuSeparator />
          {children.length > 0 && <CtxRow glyph={GLYPH_FOR_VERB['overview']} label="Overview" onClick={menuItem(() => openSideOverview(info.id))} />}
          {info.spawned_by != null && onReturnChildToRoster && <CtxRow glyph={IconArrowUpRight} label="Return to roster" onClick={menuItem(() => onReturnChildToRoster(info.id))} />}
          <CtxRow glyph={IconPencil} label="Generate title" disabled={!['codename', 'prompt'].includes(info.title_source)} disabledReason="A generated title requires a codename or first-prompt name" onClick={menuItem(() => setConfirmGenerateTitle(true))} />
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
          <TextAndHandoffRows
            thread={info.view === 'thread'}
            keymapOverrides={keymapOverrides}
            menuItem={menuItem}
            onZoom={onZoom}
            onHandoff={() =>
              onHandoff({
                session: info.id,
                agent: glyphAgent,
                title: info.title,
                cwd,
                conversation: clampConversation(termActions.current?.readOutput('all') ?? '')
              })
            }
          />
          <PaneContextMenuSeparator />
          <InterruptRows info={info} live={live} client={client} menuItem={menuItem} termActions={termActions} />
          {!sleeping && restartEntries({
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
            glyph={GLYPH_FOR_VERB['reveal-in-file-manager']}
            label="Reveal in file manager"
            onClick={menuItem(() => {
              void showItemInFolder(cwd).then((res) => {
                if (res.ok) return
                if (termActions.current) termActions.current.toast(res.error)
                else showLifecycleError(res.error)
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

function SleepingSessionPlaceholder({ info, onWake, onFresh }: { info: SessionInfo; onWake: () => void; onFresh: () => void }): React.JSX.Element {
  const sleptDuration = info.slept_at_ms == null ? null : Math.max(0, Date.now() - info.slept_at_ms)
  return <section aria-label="Sleeping session" className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
    <Inset space="screen" className="w-full"><Card padding="md" layout="sleeping-session">
      <Text as="h2" size="heading" weight="heading" tone="primary" flush>Session sleeping</Text>
      <Text tone="secondary" flush>Wake this conversation explicitly when you want to continue. Focusing this pane will not start it.</Text>
      <Text size="small" tone="muted" flush>Time asleep: {sleptDuration == null ? 'unavailable' : formatElapsed(sleptDuration)}. Expiration: unknown.</Text>
      {info.context && <Text size="small" tone="muted" flush>Context used: {info.context.used_percent ?? 'Unknown'}%</Text>}
      {info.latest_prompt && <div className="grid gap-[var(--space-1)]"><Text size="small" tone="muted">Last prompt</Text><Card padding="sm" layout="scrolling-copy">{info.latest_prompt}</Card></div>}
      {info.last_agent_message && <div className="grid gap-[var(--space-1)]"><Text size="small" tone="muted">Last agent message</Text><Card padding="sm" layout="scrolling-copy">{info.last_agent_message}</Card></div>}
      <Inline wrap className="justify-center"><Button variant="primary" onClick={onWake}>Wake session</Button><Button variant="secondary" onClick={onFresh}>Start fresh session</Button></Inline>
    </Card></Inset>
  </section>
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function formatMemory(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[unit]}`
}

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
              return <PeekTerminalLayer key={shown.id} sessionId={shown.id} hidden={hidden}>
                {shown.id !== info.id && <ChildInputBanner info={shown} client={client} />}
                <GridHiddenContext.Provider value={gridHidden || hidden}>
                  <WarmContext.Provider value={gridWarm || hidden}>
                    {shown.view === 'thread' ? <threadPane.Slot client={client} info={shown} connected={connected} /> : <TerminalPane client={client} info={shown} theme={theme} active={active && !hidden} connected={connected} fontSize={fontSize} fontFamily={fontFamily} shiftEnterNewline={shiftEnterNewline} openLinksInPane={openLinksInPane} onOpenUrlInPane={onOpenUrlInPane} copyOnSelect={copyOnSelect} stripBoxGlyphs={stripBoxGlyphs} registerOutput={registerOutput} onActivate={() => onActivate(info.id)} onZoom={onZoom} onShellZoom={onShellZoom} onOpenFile={(path, line, col) => onOpenFile(shown.id, path, line, col)} onOpenDir={(path) => onOpenDir(path, shown.id)} actions={shown.id === info.id ? termActions : undefined} />}
                  </WarmContext.Provider>
                </GridHiddenContext.Provider>
              </PeekTerminalLayer>
            })}</>
}

function SessionHeaderStatusDot({ info, live }: { info: SessionInfo; live: boolean }): React.JSX.Element {
  const delegating = useSessionsSelector(useCallback((sessions) => hasWorkingDescendant(info.id, sessions.values()), [info.id]), Object.is, false)
  if (info.spawned_by != null) return <ChildStatusDot info={info} />
  const status = needsUserInput(info) ? 'needs-input' : askedOrchestrator(info) ? 'idle' : info.status === 'idle' && delegating ? 'working' : attentionStatus(info)
  return <StatusDot status={status} live={live || info.children_waiting > 0} />
}

// Provider-reported only: no hook reports a reset time, so none is shown.
function PaneLimitDetail({ limit }: { limit: SessionInfo['limit'] }): React.JSX.Element | null {
  if (limit == null) return null
  const label = `Limited: the provider reported ${limit.error}${limit.details ? ` (${limit.details})` : ''} with no reset time. It clears when the next turn starts.`
  return <Tooltip label={label}><span data-testid="pane-limit" aria-label={label} className="flex-none"><StatusLabel variant="detail" status="Limited" /></span></Tooltip>
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
          {live && <PaneLimitDetail limit={info.limit} />}
          <ContextIndicator context={info.context} />
          {ended && (
            <PaneStateChip data-testid="pane-state" className="[@container_(max-width:490px)]:hidden" state={info.state}>
              {ended}
            </PaneStateChip>
          )}
          {!live && (
            <Tooltip
              label={info.state === 'sleeping' ? 'Wake conversation' : restartTooltip(info)}
            >
              <PaneHeadButton
                aria-label={info.state === 'sleeping' ? 'Wake conversation' : info.agent === 'ssh' ? 'Reconnect' : 'Restart'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (info.agent === 'ssh') onReconnectSsh(info.id)
                  else if (info.state === 'sleeping') client.send({ type: 'session_wake', session: info.id })
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

function ChildrenRoom({ info, children, roster, client, peek, selectChild, moveChild, mode, onMode, terminals }: Pick<Props, 'info' | 'roster' | 'client'> & {
  children: SessionInfo[]
  peek: SessionInfo | undefined
  selectChild: (id: number | null) => void
  moveChild: (id: number) => void
  mode: RosterMode
  onMode: (mode: RosterMode) => void
  terminals: React.ReactNode
}): React.JSX.Element {
  return (<><RosterSplit mode={mode}>
        {children.length > 0 && <ChildrenRoster parent={info} children={children} roster={roster} client={client} selected={peek?.id ?? null} onSelect={selectChild} onMove={moveChild} collapsed={mode === 'collapsed'} onCollapse={() => onMode('collapsed')} onExpand={() => onMode('expanded')} />}
        <ChildrenColumn>
          {/* The bar stays while the pane has children: shown only while peeking, it
              would resize every kept-mounted terminal and make each CLI repaint on switch. */}
          {children.length > 0 && <RosterPeekbar>
            {peek ? <>
              <PeekBarButton onClick={() => selectChild(null)}>Orchestrator</PeekBarButton><span>/</span><strong className="truncate min-w-0">{peek.delegation?.role ?? peek.title}</strong>
              <span className="flex-1" /><PeekBarButton shrink onClick={() => openSideOverview(info.id)}>Instructions</PeekBarButton><PeekBarButton shrink onClick={() => moveChild(peek.id)}>Move to grid</PeekBarButton>
              <Tooltip label="Return to orchestrator"><PeekBarIconButton aria-label="Return to orchestrator" onClick={() => selectChild(null)}><Icon glyph={IconClose} role="ui" /></PeekBarIconButton></Tooltip>
            </> : <strong className="truncate min-w-0">Orchestrator</strong>}
          </RosterPeekbar>}
          <div className="relative flex-1 min-h-0 min-w-0">
            {terminals}
            {peek && !isLive(peek.state) && <SettledChildBar info={peek} client={client} onMove={moveChild} />}
          </div>
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
