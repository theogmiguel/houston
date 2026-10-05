import { useEffect, useState } from 'react'
import type { DelegationInfo } from '../houston/generated/DelegationInfo'
import type { SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { Icon } from './Icon'
import { IconEye, IconGitFork } from './icons'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS, popOriginStyle } from './overlayChrome'
import { Button } from './ui'
import { StatusLabel } from './ui'
import { Tooltip } from './Tooltip'
import { ProvisionalMarker, sessionCodename, sessionIdentity, sessionTaskLabel, stateWord, type BadgeKind, type PaneRoster } from './DelegationCard'

function isWaiting(d: DelegationInfo | null | undefined): boolean {
  return d != null && (d.stalled || d.state === 'needs_input')
}

function workspaceLabel(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).pop() || path
}

function stateTone(d: DelegationInfo): string {
  if (isWaiting(d)) return 'text-[var(--warn)]'
  if (d.state === 'failed') return 'text-[var(--status-blocked-text)]'
  if (d.state === 'working' || d.state === 'spawning') return 'text-[var(--ok)]'
  return 'text-[var(--text-muted)]'
}

function pillTone(d: DelegationInfo): 'waiting' | 'failed' | 'done' | 'working' | 'unknown' {
  if (isWaiting(d)) return 'waiting'
  if (d.state === 'failed') return 'failed'
  if (d.state === 'done') return 'done'
  if (d.state === 'working' || d.state === 'spawning') return 'working'
  return 'unknown'
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
                    <Button
                      type="button"
                      variant="ghost"
                      className="self-start px-1.5 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)]"
                      onClick={() => onDeliverNow(parentId)}
                    >
                      Deliver now
                    </Button>
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
              <Button
                key={c.id}
                type="button"
                variant="text"
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
              </Button>
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
          <StatusLabel status="Needs input" variant="pill" tone="waiting">
            {waiting} waiting
          </StatusLabel>
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
        <StatusLabel status="Working" variant="pill" tone={pillTone(info.delegation)}>
          {stateWord(info.delegation)}
        </StatusLabel>
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
      <Button
        type="button"
        variant="ghost"
        className={LEVER_CLS}
        onClick={() => {
          onDone()
          onFocusPane(target)
        }}
      >
        <Icon glyph={IconEye} role="label" />
        Focus parent
      </Button>
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

export default function DelegationPanel({
  cardRef,
  id,
  label,
  anchorRef,
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
  anchorRef: React.RefObject<HTMLButtonElement | null>
  kind: BadgeKind
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  onDeliverNow?: (session: number) => void
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}): React.JSX.Element {
  const place = useCardPlacement(true, anchorRef, cardRef, info)
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
