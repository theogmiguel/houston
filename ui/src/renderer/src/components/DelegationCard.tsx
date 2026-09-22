import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DelegationInfo } from '../houston/generated/DelegationInfo'
import type { SessionInfo } from '../houston/client'
import { Icon } from './Icon'
import { IconCornerDownRight, IconEye, IconGitFork } from './icons'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS, popOriginStyle } from './overlayChrome'
import { BTN_GHOST } from './buttonChrome'
import { HOVER_DELAY_MS, Tooltip } from './Tooltip'
import { HEAD_BADGE_CLS } from './headBadge'
import { isLive } from '../houston/client'

export interface PaneRoster {
  sessions: ReadonlyMap<number, SessionInfo>
  maxLiveChildren: number | null
}

function isWaiting(d: DelegationInfo | null | undefined): boolean {
  return d != null && (d.stalled || d.state === 'needs_input')
}

export function sessionCodename(info: { codename?: string | null }): string | null {
  const codename = typeof info.codename === 'string' ? info.codename.trim() : ''
  return codename || null
}

export function sessionIdentity(info: { id: number; codename?: string | null }): string {
  return sessionCodename(info) ?? `#${info.id}`
}

export function sessionTaskLabel(info: {
  title?: string | null
  codename?: string | null
}): string | null {
  const title = typeof info.title === 'string' ? info.title.trim() : ''
  return title !== '' && title !== sessionCodename(info) ? title : null
}

function titleIsCodename(info: { title?: string | null; codename?: string | null }): boolean {
  const codename = sessionCodename(info)
  return codename != null && typeof info.title === 'string' && info.title.trim() === codename
}

function workspaceLabel(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).pop() || path
}

// `unknown` is ignorance, not a verdict: the daemon restarted mid-flight, so
// nobody knows how the work ended. Saying "failed" would be a claim about the
// child rather than about Houston.
function stateWord(d: DelegationInfo): string {
  if (d.stalled && d.state === 'working') return 'stalled'
  switch (d.state) {
    case 'needs_input':
      return 'needs input'
    case 'unknown':
      return 'unknown'
    default:
      return d.state
  }
}

function stateTone(d: DelegationInfo): string {
  if (isWaiting(d)) return 'text-[var(--warn)]'
  if (d.state === 'failed') return 'text-[var(--status-blocked-text)]'
  if (d.state === 'working' || d.state === 'spawning') return 'text-[var(--ok)]'
  return 'text-[var(--text-muted)]'
}

const PILL_CLS =
  'inline-flex items-center h-[17px] px-2 rounded-[var(--tr-radius-sm)] flex-none ' +
  '[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] ' +
  '[letter-spacing:var(--tr-text-label-tracking)] uppercase'

function pillCls(d: DelegationInfo): string {
  if (isWaiting(d))
    return `${PILL_CLS} bg-[var(--status-todo-bg)] text-[var(--status-todo-text)]`
  if (d.state === 'failed')
    return `${PILL_CLS} bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)]`
  if (d.state === 'done')
    return `${PILL_CLS} bg-[var(--status-done-bg)] text-[var(--status-done-text)]`
  if (d.state === 'working' || d.state === 'spawning')
    return `${PILL_CLS} bg-[var(--status-doing-bg)] text-[var(--status-doing-text)]`
  return `${PILL_CLS} bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-muted)]`
}

function agoLabel(endedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - endedAt) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

const ROW_LABEL_CLS = 'text-[var(--text-muted)] [font-size:var(--tr-text-xs)]'
const ROW_VALUE_CLS =
  'm-0 text-[var(--text-secondary)] [font-size:var(--tr-text-xs)] [overflow-wrap:anywhere]'

export function ProvisionalMarker(): React.JSX.Element {
  return (
    <Tooltip label="released on a stop with no sub-agent evidence; a correction may follow">
      <span className="shrink-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]">
        may be corrected
      </span>
    </Tooltip>
  )
}

function CardRow({
  label,
  children,
  tone
}: {
  label: string
  children: React.ReactNode
  tone?: string
}): React.JSX.Element {
  return (
    <>
      <dt className={ROW_LABEL_CLS}>{label}</dt>
      <dd className={`${ROW_VALUE_CLS} ${tone ?? ''}`}>{children}</dd>
    </>
  )
}

const SECTION_CLS = 'border-t border-t-[var(--divider)] px-3 py-2.5 flex flex-col gap-2'
const SECTION_LABEL_CLS =
  '[font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] ' +
  '[letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)] m-0'

function ChildIdentityLine({
  info,
  parent
}: {
  info: SessionInfo
  parent: SessionInfo | undefined
}): React.JSX.Element {
  const parentId = info.delegation?.parent ?? info.spawned_by
  const parentName = parent != null ? sessionCodename(parent) : null
  const parentShort = parentName ?? (parentId != null ? `#${parentId}` : null)
  return (
    <div className="px-3 pb-2.5 text-[var(--text-muted)] [font-size:var(--tr-text-xs)]">
      {info.detected_agent ?? info.agent}
      {parentShort != null && (
        <>
          <span className="mx-[5px] text-[var(--text-faint)]">·</span>
          child of{' '}
          <Tooltip label={parentId != null ? `child of ${parentShort} · pane ${parentId}` : undefined}>
            <b className="text-[var(--text-secondary)]">{parentShort}</b>
          </Tooltip>
        </>
      )}
    </div>
  )
}

function OwedRows({ d }: { d: DelegationInfo }): React.JSX.Element | null {
  if (d.inbox_owed === 0 && d.last_result_corrected_by == null && d.inbox_provisional === 0)
    return null
  return (
    <>
      {d.inbox_owed > 0 && (
        <CardRow label="owed" tone="text-[var(--text-primary)] font-semibold">
          {d.inbox_owed} owed to parent
          {d.inbox_provisional > 0 && ` · ${d.inbox_provisional} provisional`}
        </CardRow>
      )}
      {(d.last_result_corrected_by != null || d.inbox_provisional > 0) && (
        <CardRow label="last result">
          {d.last_result_corrected_by != null ? (
            <span>
              corrected by <span className="tabular-nums">#{d.last_result_corrected_by}</span>
            </span>
          ) : (
            <ProvisionalMarker />
          )}
        </CardRow>
      )}
    </>
  )
}

function RecordBody({
  info,
  parent,
  onDeliverNow
}: {
  info: SessionInfo
  parent: SessionInfo | undefined
  onDeliverNow?: (session: number) => void
}): React.JSX.Element {
  const d = info.delegation
  const parentId = d?.parent ?? info.spawned_by
  return (
    <>
      <ChildIdentityLine info={info} parent={parent} />
      {d && (
        <div className={SECTION_CLS}>
          <dl className="m-0 grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-[5px] items-baseline">
            <CardRow label="workspace">
              <Tooltip label={info.project_dir}>{workspaceLabel(info.project_dir)}</Tooltip>
            </CardRow>
            {d.role != null && (
              <CardRow label="role" tone="text-[var(--text-primary)] font-semibold">
                {d.role}
              </CardRow>
            )}
            <CardRow label="state" tone={`font-semibold ${stateTone(d)}`}>
              {stateWord(d)}
            </CardRow>
            {d.stalled && (
              <CardRow label="stalled" tone="text-[var(--warn)] font-semibold">
                no output, and nothing running under the pane
              </CardRow>
            )}
            {d.result_staged && (
              <CardRow label="result" tone="text-[var(--text-primary)] font-semibold">
                staged, not yet handed back
              </CardRow>
            )}
            {d.superseded > 0 && (
              <CardRow label="superseded">{d.superseded} earlier partial result(s)</CardRow>
            )}
            <OwedRows d={d} />
            {d.hold_reason != null && (
              <CardRow label="waiting">
                <span className="flex flex-col gap-1">
                  <span>{d.hold_reason}</span>
                  {parentId != null && onDeliverNow != null && (
                    <button
                      type="button"
                      className={`btn ${BTN_GHOST} self-start px-1.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]`}
                      onClick={() => onDeliverNow(parentId)}
                    >
                      Deliver now
                    </button>
                  )}
                </span>
              </CardRow>
            )}
            {d.ended_at != null && (
              <CardRow label="ended">
                {new Date(d.ended_at).toLocaleTimeString()}{' '}
                <span className="text-[var(--text-faint)] font-normal">
                  · {agoLabel(d.ended_at)}
                </span>
              </CardRow>
            )}
            {d.stop_reason != null && <CardRow label="stop reason">{d.stop_reason}</CardRow>}
            {d.capability_note != null && (
              <CardRow label="capability">{d.capability_note}</CardRow>
            )}
            <CardRow label="turn ends on">
              {d.turn_end_source}
              {d.turn_end_source === 'quiet-settle' && (
                <span className="text-[var(--text-faint)]"> (Houston's judgement, not a report)</span>
              )}
            </CardRow>
          </dl>
        </div>
      )}
    </>
  )
}

const CREW_ROW_CLS =
  'flex items-center gap-2 min-h-[var(--h-pill)] px-3 w-full text-left border-0 bg-transparent ' +
  'font-[inherit] [font-size:var(--tr-text-xs)] text-[var(--text-secondary)] cursor-pointer ' +
  'transition-[background] hover:bg-[var(--hover-fill)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:-2px]'

function RosterBody({
  info,
  crew,
  cap,
  onFocusPane
}: {
  info: SessionInfo
  crew: SessionInfo[]
  cap: number | null
  onFocusPane?: (id: number) => void
}): React.JSX.Element {
  const atCap = cap != null && crew.length >= cap
  return (
    <>
      <div className="px-3 pb-2.5 text-[var(--text-muted)] [font-size:var(--tr-text-xs)]">
        this pane{' '}
        <b className="text-[var(--text-secondary)]">
          {sessionIdentity(info)}
          {sessionTaskLabel(info) != null && ` · ${sessionTaskLabel(info)}`}
        </b>
        {atCap && (
          <>
            <span className="mx-[5px] text-[var(--text-faint)]">·</span>
            <b className="text-[var(--warn)]">
              {crew.length} of {cap} live children — at the cap
            </b>
          </>
        )}
      </div>
      <div className={SECTION_CLS}>
        <p className={SECTION_LABEL_CLS}>Children · waiting first</p>
        <div className="flex flex-col -mx-3 -mb-2.5">
          {crew.map((c) => {
            const d = c.delegation
            const secondary = [d?.role, sessionTaskLabel(c)].filter(
              (value): value is string => value != null
            )
            return (
              <button
                key={c.id}
                type="button"
                className={CREW_ROW_CLS}
                onClick={() => onFocusPane?.(c.id)}
              >
                <span
                  data-testid="roster-identity"
                  className="flex-none font-semibold text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis max-w-[16ch]"
                >
                  {sessionIdentity(c)}
                </span>
                <span
                  data-testid="roster-secondary"
                  className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-[var(--text-faint)]"
                >
                  {secondary.join(' · ')}
                </span>
                <span
                  className={`ml-auto flex-none [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] uppercase ${
                    d ? stateTone(d) : 'text-[var(--text-muted)]'
                  }`}
                >
                  {d ? stateWord(d) : 'no record'}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

const LEVER_CLS =
  'h-[var(--h-pill)] px-2.5 inline-flex items-center gap-1.5 border border-[var(--border)] ' +
  'rounded-[var(--tr-radius-button)] bg-[var(--surface)] text-[var(--text-secondary)] ' +
  'font-[inherit] [font-size:var(--tr-text-xs)] cursor-pointer ' +
  'transition-[background,border-color] hover:bg-[var(--hover-fill)] ' +
  'hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:1px]'

const OFFSET_PX = 6
const VIEWPORT_MARGIN_PX = 8
const CARD_W = 304

export type BadgeKind = 'origin' | 'orchestrator'

function parentShort(info: SessionInfo, roster: PaneRoster | undefined): string | null {
  const parentId = info.spawned_by
  if (parentId == null) return null
  const codename = roster != null ? sessionCodename(roster.sessions.get(parentId) ?? {}) : null
  if (codename) return codename
  return `#${parentId}`
}

function badgeLabel(
  kind: BadgeKind,
  info: SessionInfo,
  originName: string | null
): string {
  const identity = sessionIdentity(info)
  if (kind === 'origin')
    return originName != null
      ? `${identity} · child of ${originName}`
      : `${identity} · this pane is an orchestration child`
  const base = `${identity} · orchestrating ${info.live_children} live child panes`
  return info.children_waiting > 0
    ? `${base}; ${info.children_waiting} waiting on you`
    : base
}

function crewOf(
  sessions: ReadonlyMap<number, SessionInfo> | undefined,
  parentId: number
): SessionInfo[] {
  if (!sessions) return []
  return [...sessions.values()]
    .filter((s) => s.spawned_by === parentId && isLive(s.state))
    .sort(
      (a, b) => Number(isWaiting(b.delegation)) - Number(isWaiting(a.delegation)) || a.id - b.id
    )
}

function BadgeContent({
  kind,
  info,
  selfName
}: {
  kind: BadgeKind
  info: SessionInfo
  selfName: string
}): React.JSX.Element {
  const showIdentity = !titleIsCodename(info)
  if (kind === 'origin') return showIdentity ? <>{selfName}</> : <></>
  const count = info.children_waiting === 0 ? (
    <>{info.live_children}</>
  ) : (
    <span className="inline-flex items-baseline">
      <span className="text-[var(--warn)]">{info.children_waiting}</span>
      <span className="px-px text-[var(--text-muted)]">/</span>
      {info.live_children}
    </span>
  )
  if (!showIdentity || info.spawned_by != null) return count
  return (
    <span className="inline-flex items-baseline">
      {selfName}
      <span className="px-px text-[var(--text-muted)]"> · </span>
      {count}
    </span>
  )
}

const CARD_TITLE_CLS =
  'min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-[var(--text-primary)] ' +
  '[font-size:var(--tr-text-base)] font-semibold'

function CardHead({ kind, info }: { kind: BadgeKind; info: SessionInfo }): React.JSX.Element {
  const waiting = info.children_waiting
  const identity = sessionIdentity(info)
  if (kind === 'orchestrator') {
    return (
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <Icon
          glyph={IconGitFork}
          role="small"
          className={waiting > 0 ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}
        />
        <span className={`${CARD_TITLE_CLS} flex-none`}>{identity}</span>
        <span className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-[var(--text-muted)] [font-size:var(--tr-text-xs)]">
          · {info.live_children} live
        </span>
        <span className="ml-auto" />
        {waiting > 0 && (
          <span className={`${PILL_CLS} bg-[var(--status-todo-bg)] text-[var(--status-todo-text)]`}>
            {waiting} waiting
          </span>
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
      <span className={`${CARD_TITLE_CLS} flex-none`}>{identity}</span>
      {sessionTaskLabel(info) != null && (
        <span className="min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-[var(--text-muted)] [font-size:var(--tr-text-xs)]">
          {sessionTaskLabel(info)}
        </span>
      )}
      <span className="ml-auto" />
      {info.delegation && (
        <span className={pillCls(info.delegation)}>{stateWord(info.delegation)}</span>
      )}
    </div>
  )
}

// The card's ONLY lever. `pane_send_keys` and Kill are deliberately absent: a
// surface that opens on hover is not where an operator gains new power over a
// running agent.
function FocusLever({
  target,
  onFocusPane,
  onDone
}: {
  target: number
  onFocusPane: (id: number) => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <div className={SECTION_CLS}>
      <button
        type="button"
        className={LEVER_CLS}
        onClick={() => {
          onDone()
          onFocusPane(target)
        }}
      >
        <Icon glyph={IconEye} role="label" />
        Focus parent
      </button>
    </div>
  )
}

function useCardPlacement(
  open: boolean,
  anchorRef: React.RefObject<HTMLButtonElement | null>,
  cardRef: React.RefObject<HTMLDivElement | null>,
  dep: unknown
): { top: number; left: number } | null {
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!open) {
      setPlace(null)
      return
    }
    const anchor = anchorRef.current
    const card = cardRef.current
    if (!anchor || !card) return
    const a = anchor.getBoundingClientRect()
    const h = card.getBoundingClientRect().height
    const below = a.bottom + OFFSET_PX
    const fitsBelow = below + h <= window.innerHeight - VIEWPORT_MARGIN_PX
    const top = fitsBelow ? below : Math.max(VIEWPORT_MARGIN_PX, a.top - h - OFFSET_PX)
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - CARD_W - VIEWPORT_MARGIN_PX)
    setPlace({ top, left: Math.max(VIEWPORT_MARGIN_PX, Math.min(a.left, maxLeft)) })
  }, [open, anchorRef, cardRef, dep])
  return place
}

function CardPanel({
  cardRef,
  id,
  label,
  place,
  kind,
  info,
  roster,
  onFocusPane,
  onDeliverNow,
  onClose,
  onPointerEnter,
  onPointerLeave
}: {
  cardRef: React.RefObject<HTMLDivElement | null>
  id: string
  label: string
  place: { top: number; left: number } | null
  kind: BadgeKind
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  onDeliverNow?: (session: number) => void
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}): React.JSX.Element {
  const parentId = kind === 'origin' ? info.spawned_by : null
  const sessions = roster?.sessions
  return (
    <div
      ref={cardRef}
      id={id}
      role="dialog"
      aria-label={label}
      {...OVERLAY_RAISED_ATTRS}
      className={`${OVERLAY_RAISED_CLS} fixed z-[var(--z-overlay)] w-[304px] overflow-hidden`}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        visibility: place ? 'visible' : 'hidden',
        ...popOriginStyle('left', 'top')
      }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <CardHead kind={kind} info={info} />
      {kind === 'orchestrator' ? (
        <RosterBody
          info={info}
          crew={crewOf(sessions, info.id)}
          cap={roster?.maxLiveChildren ?? null}
          onFocusPane={onFocusPane}
        />
      ) : (
        <RecordBody
          info={info}
          parent={parentId != null ? sessions?.get(parentId) : undefined}
          onDeliverNow={onDeliverNow}
        />
      )}
      {parentId != null && onFocusPane != null && (
        <FocusLever target={parentId} onFocusPane={onFocusPane} onDone={onClose} />
      )}
    </div>
  )
}

const BADGE_CLS =
  `${HEAD_BADGE_CLS} gap-1.5 [font-variant-numeric:tabular-nums] rounded-[var(--tr-radius-sm)] ` +
  'hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)] ' +
  'focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:[outline-offset:2px]'

export function HeaderDelegationBadge({
  kind,
  info,
  roster,
  onFocusPane,
  onDeliverNow
}: {
  kind: BadgeKind
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  onDeliverNow?: (session: number) => void
}): React.JSX.Element {
  const id = useId()
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pinnedRef = useRef(false)
  const [open, setOpen] = useState(false)

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const close = useCallback(() => {
    cancelTimer()
    pinnedRef.current = false
    setOpen(false)
  }, [cancelTimer])

  const openAfterDelay = useCallback(() => {
    cancelTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      setOpen(true)
    }, HOVER_DELAY_MS)
  }, [cancelTimer])

  const leave = useCallback(() => {
    cancelTimer()
    if (!pinnedRef.current) setOpen(false)
  }, [cancelTimer])

  useEffect(() => cancelTimer, [cancelTimer])

  const place = useCardPlacement(open, btnRef, cardRef, info)

  const originName = kind === 'origin' ? parentShort(info, roster) : null
  const selfName = sessionIdentity(info)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || cardRef.current?.contains(t)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open, close])

  const label = badgeLabel(kind, info, originName)
  const glyphWarn = kind === 'origin' && info.delegation?.stalled === true

  const badge = (
    <button
      ref={btnRef}
      type="button"
      data-testid={kind === 'origin' ? 'origin-badge' : 'orchestrator-badge'}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      className={BADGE_CLS}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={openAfterDelay}
      onPointerLeave={leave}
      onFocus={() => setOpen(true)}
      onClick={(e) => {
        e.stopPropagation()
        pinnedRef.current = !pinnedRef.current
        setOpen(true)
      }}
    >
      <Icon
        glyph={kind === 'origin' ? IconCornerDownRight : IconGitFork}
        role="label"
        className={glyphWarn ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}
      />
      <BadgeContent kind={kind} info={info} selfName={selfName} />
    </button>
  )
  return (
    <>
      <Tooltip label={label}>{badge}</Tooltip>
      {open &&
        createPortal(
          <CardPanel
            cardRef={cardRef}
            id={id}
            label={label}
            place={place}
            kind={kind}
            info={info}
            roster={roster}
            onFocusPane={onFocusPane}
            onDeliverNow={onDeliverNow}
            onClose={close}
            onPointerEnter={cancelTimer}
            onPointerLeave={leave}
          />,
          document.body
        )}
    </>
  )
}
