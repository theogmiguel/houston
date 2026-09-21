import { memo, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { RING_ACCENT_ICON } from './shadowChrome'
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
import { AnimOut, MenuLayer } from './AnimOut'
import { ConfirmModal } from './ConfirmModal'
import type { HandoffSource } from './PaneHandoff'
import { clampConversation } from './handoffPacket'
import { RenameTitle } from './RenameTitle'
import { Tooltip } from './Tooltip'
import {
  IconAgent,
  IconArrowUpRight,
  IconClose,
  IconCopy,
  IconEllipsis,
  IconEraser,
  IconFolder,
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
import { BTN_ICO_STRUCTURE } from './buttonChrome'
import { CONTROL_SIZE_SQUARE_CLS } from './controlSize'
import { PANE_BORDER_CLS, PANE_HEAD_BG_CLS, usePaneFocusTier } from '../windowFocus'
import { KeymapOverridesContext } from '../layout/keymapOverridesContext'
import {
  effectiveLabel,
  fontZoomIn,
  fontZoomOut,
  movePaneNext,
  movePanePrev,
  splitDown,
  splitRight
} from '../keymap'
import { ICON_ROLE_CLS, Icon } from './Icon'
import { HEAD_BADGE_CLS } from './headBadge'
import { HeaderDelegationBadge, type PaneRoster } from './DelegationCard'
import { POP_ORIGIN_CLS, popOriginStyle } from './overlayChrome'
import { usePaneContextMenu } from './paneContextMenu'
import { ContextIndicator } from './ContextIndicator'

export const HEAD_ICON_CLS = ICON_ROLE_CLS.ui

export const HANDOFF_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode', 'cursor', 'grok'] as const
export type HandoffProvider = (typeof HANDOFF_PROVIDERS)[number]

export type NoticeRingTone = 'completed' | 'error' | 'needs-input'

const paneNoticeRings = new Map<number, NoticeRingTone>()
const paneRingListeners = new Set<() => void>()

function notifyPaneRingListeners(): void {
  for (const l of paneRingListeners) l()
}

export function setPaneNoticeRing(session: number, tone: NoticeRingTone): void {
  paneNoticeRings.set(session, tone)
  notifyPaneRingListeners()
}

export function clearAllPaneNoticeRings(): void {
  if (paneNoticeRings.size === 0) return
  paneNoticeRings.clear()
  notifyPaneRingListeners()
}

export function clearPaneNoticeRing(session: number): void {
  if (paneNoticeRings.delete(session)) notifyPaneRingListeners()
}

export function resetPaneNoticeRingsForTests(): void {
  paneNoticeRings.clear()
}

function usePaneNoticeRing(session: number): NoticeRingTone | null {
  return useSyncExternalStore(
    (onChange) => {
      paneRingListeners.add(onChange)
      return () => paneRingListeners.delete(onChange)
    },
    () => paneNoticeRings.get(session) ?? null
  )
}

export function endedLabel(s: SessionInfo['state']): string | null {
  switch (s) {
    case 'exited':
      return 'DONE'
    case 'killed':
      return 'KILLED'
    case 'interrupted':
      return 'INTERRUPTED'
    default:
      return null
  }
}

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

const ENGINE_GLYPH_COLOR: Partial<Record<AgentKind, string>> = {
  claude: 'var(--claude)',
  codex: 'var(--codex)',
  antigravity: 'var(--antigravity)',
  opencode: 'var(--opencode)',
  cursor: 'var(--cursor)',
  grok: 'var(--grok)'
}
export function engineGlyphColor(agent: AgentKind): string {
  return ENGINE_GLYPH_COLOR[agent] ?? 'var(--text-muted)'
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
  const pulse = 'loop-anim [--dot-pulse-opacity:0.35] motion-safe:animate-[dot-pulse_1.4s_ease-in-out_infinite]'
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
  onOpenDir: (path: string) => void
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
}

function SessionPaneImpl({
  client,
  info,
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
  roster,
  onFocusPane
}: Props): React.JSX.Element {
  const live = isLive(info.state)
  const ended = endedLabel(info.state)

  const focusTier = usePaneFocusTier(active)

  const noticeRing = usePaneNoticeRing(info.id)
  useEffect(() => {
    if (active && paneNoticeRings.delete(info.id)) notifyPaneRingListeners()
  }, [active, info.id])

  const keymapOverrides = useContext(KeymapOverridesContext)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const termActions = useRef<TermActions | null>(null)
  const [menuCwd, setMenuCwd] = useState<string | null>(null)

  const cwd = menuCwd ?? info.cwd
  const menuSideEffects = (): void => {
    setMenuCwd(null)
    client.sessionCwd(info.id).then(setMenuCwd, () => setMenuCwd(info.cwd))
  }
  const { menu, openMenuAt, openMenuAtButton, closeMenu, menuItem, menuRef } =
    usePaneContextMenu(menuSideEffects)

  const glyphAgent: AgentKind = info.detected_agent ?? info.agent
  return (
    <section
      className={`pane flex-1 min-w-0 min-h-0 relative flex flex-col border ${PANE_BORDER_CLS[focusTier]} bg-[var(--terminal-frame-bg)] rounded-[var(--tr-radius-md)] [@container_(max-width:280px)]:rounded-[var(--tr-radius-sm)] overflow-hidden ${ended ? 'opacity-80' : ''} ${active ? 'focus' : ''}`}
      data-panekey={info.id}
      onPointerDownCapture={() => onActivate(info.id)}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.pane-head')) return
        e.preventDefault()
        openMenuAt(e.clientX, e.clientY)
      }}
    >
      {noticeRing && <div aria-hidden className={`notice-ring pane-notice-ring ${noticeRing}`} />}
      <header
        className={`group pane-head touch-none flex items-center gap-2 pr-1 pl-[10px] h-[var(--h-pane-head)] min-h-[var(--h-pane-head)] border-b border-b-[var(--divider)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] tracking-[-0.005em] text-[var(--text-primary)] flex-none cursor-grab active:cursor-grabbing [.pane-slot.drag-src_&]:cursor-grabbing [transition:background_0.2s] @container ${PANE_HEAD_BG_CLS[focusTier]}`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button, input, [data-pane-head-control]')) return
          onHeaderPointerDown(info.id, e)
        }}
      >
        <span
          data-testid="head-identity"
          className="head-identity inline-flex items-center gap-2 min-w-0 overflow-hidden [flex:0_1_auto]"
        >
          <StatusDot status={info.status} live={live} />
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
          {info.spawned_by != null && (
            <OriginBadge
              info={info}
              roster={roster}
              onFocusPane={onFocusPane}
              onDeliverNow={(session) => client.inboxDeliverNow(session)}
            />
          )}
          {info.live_children > 0 && (
            <OrchestratorBadge info={info} roster={roster} onFocusPane={onFocusPane} />
          )}
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
        <span className="head-actions ml-auto flex items-center gap-px flex-none">
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
              label={
                info.agent === 'ssh'
                  ? 'Reconnect (opens the SSH dialog prefilled)'
                  : 'Restart (a fresh agent, not the old conversation)'
              }
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
                if (menu) {
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
        </span>
      </header>
      <TerminalPane
        client={client}
        info={info}
        theme={theme}
        active={active}
        connected={connected}
        fontSize={fontSize}
                fontFamily={fontFamily}
                shiftEnterNewline={shiftEnterNewline}
                openLinksInPane={openLinksInPane}
                onOpenUrlInPane={onOpenUrlInPane}
        copyOnSelect={copyOnSelect}
        stripBoxGlyphs={stripBoxGlyphs}
        registerOutput={registerOutput}
        onActivate={() => onActivate(info.id)}
        onZoom={onZoom}
        onShellZoom={onShellZoom}
        onOpenFile={(path, line, col) => onOpenFile(info.id, path, line, col)}
        onOpenDir={onOpenDir}
        actions={termActions}
      />
      <DictationIndicator session={info.id} />
      <AnimOut open={confirmRestart} suppress="modal">
        {confirmRestart && (
          <ConfirmModal
            message={`Restart ${info.title}? The CLI running in this pane is killed and started fresh in the same directory — anything it has not written to disk is lost.`}
            confirmLabel="Restart"
            onConfirm={() => {
              setConfirmRestart(false)
              client.respawnSession(info.id, shellIntegration, undefined, undefined, true)
            }}
            onCancel={() => setConfirmRestart(false)}
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
          <CtxRow
            glyph={IconRespawn}
            label={info.agent === 'ssh' && !live ? 'Reconnect…' : 'Restart'}
            onClick={menuItem(() => {
              if (info.agent === 'ssh' && !live) {
                onReconnectSsh(info.id)
                return
              }
              if (live) {
                setConfirmRestart(true)
                return
              }
              client.respawnSession(info.id, shellIntegration)
            })}
          />
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
