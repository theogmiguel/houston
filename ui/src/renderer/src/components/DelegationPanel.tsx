import { DelegationButton } from './ui/DelegationButtonRoles'
import { useEffect, useState } from 'react'
import type { DelegationInfo } from '../houston/generated/DelegationInfo'
import type { SessionInfo } from '../houston/client'
import { isLive } from '../houston/client'
import { Icon } from './ui/Icon'
import { IconEye, IconGitFork } from './icons'
import {
  PopoverPanel,
  CrewList,
  CrewButton,
  Emphasis,
  DefinitionEntry,
  DefinitionList,
  MutedText,
  StatusGlyph,
  PopoverHeader,
  IdentityLine,
  TabularNumber,
  DelegationSection,
  Eyebrow,
  InlineSeparator,
  PopoverDescription,
  PopoverTitle,
  PopoverActionButton,
  type DelegationTone
} from './ui/PopoverPanel'
import { StatusLabel } from './ui'
import { Tooltip } from './ui/Tooltip'
import { ProvisionalMarker, sessionCodename, sessionIdentity, sessionTaskLabel, needsHumanInput, stateWord, type BadgeKind, type PaneRoster } from './DelegationCard'

function isWaiting(d: DelegationInfo | null | undefined): boolean {
  return d != null && d.state === 'needs_input'
}

function workspaceLabel(path: string): string {
  const clean = path.replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).pop() || path
}

function stateTone(d: DelegationInfo): DelegationTone {
  if (isWaiting(d) || (d.stalled && d.state === 'working')) return 'warn'
  if (d.state === 'failed') return 'blocked'
  if (d.state === 'working' || d.state === 'spawning') return 'info'
  return 'muted'
}

function recordStateTone(d: DelegationInfo): 'warn' | undefined {
  return isWaiting(d) || (d.stalled && d.state === 'working') ? 'warn' : undefined
}

function pillTone(d: DelegationInfo): 'waiting' | 'failed' | 'done' | 'working' | 'unknown' {
  if (isWaiting(d) || (d.stalled && d.state === 'working')) return 'waiting'
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
    <IdentityLine>
      {info.detected_agent ?? info.agent}
      {parentShort != null && (
        <>
          <InlineSeparator />
          child of{' '}
          <Tooltip label={parentId != null ? `child of ${parentShort} · pane ${parentId}` : undefined}>
            <Emphasis>{parentShort}</Emphasis>
          </Tooltip>
        </>
      )}
    </IdentityLine>
  )
}

function OwedRows({ d }: { d: DelegationInfo }): React.JSX.Element | null {
  if (d.inbox_owed === 0 && d.last_result_corrected_by == null && d.inbox_provisional === 0)
    return null
  return (
    <>
      {d.inbox_owed > 0 && (
        <DefinitionEntry label="owed" bold>
          {d.inbox_owed} owed to parent
          {d.inbox_provisional > 0 && ` · ${d.inbox_provisional} provisional`}
        </DefinitionEntry>
      )}
      {(d.last_result_corrected_by != null || d.inbox_provisional > 0) && (
        <DefinitionEntry label="last result">
          {d.last_result_corrected_by != null ? (
            <span>
              corrected by <TabularNumber>#{d.last_result_corrected_by}</TabularNumber>
            </span>
          ) : (
            <ProvisionalMarker />
          )}
        </DefinitionEntry>
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
  const d = info.delegation && needsHumanInput(info) ? { ...info.delegation, state: 'needs_input' as const } : info.delegation
  const parentId = d?.parent ?? info.spawned_by
  return (
    <>
      <ChildIdentityLine info={info} parent={parent} />
      {d && (
        <DelegationSection>
          <DefinitionList>
            <DefinitionEntry label="workspace">
              <Tooltip label={info.project_dir}>{workspaceLabel(info.project_dir)}</Tooltip>
            </DefinitionEntry>
            {d.role != null && (
        <DefinitionEntry label="role" bold>
                {d.role}
              </DefinitionEntry>
            )}
            <DefinitionEntry label="state" tone={recordStateTone(d)} bold>
              {stateWord(d)}
            </DefinitionEntry>
            {d.stalled && (
              <DefinitionEntry label="stalled" tone="warn" bold>
                no output, and nothing running under the pane
              </DefinitionEntry>
            )}
            {d.result_staged && (
              <DefinitionEntry label="result" bold>
                staged, not yet handed back
              </DefinitionEntry>
            )}
            {d.superseded > 0 && (
              <DefinitionEntry label="superseded">{d.superseded} earlier partial result(s)</DefinitionEntry>
            )}
            <OwedRows d={d} />
            {d.hold_reason != null && (
              <DefinitionEntry label="waiting">
                <span className="grid gap-[var(--space-1)]">
                  <span>{d.hold_reason}</span>
                  {parentId != null && onDeliverNow != null && (
                    <PopoverActionButton onClick={() => onDeliverNow(parentId)} />
                  )}
                </span>
              </DefinitionEntry>
            )}
            {d.ended_at != null && (
              <DefinitionEntry label="ended">
                {new Date(d.ended_at).toLocaleTimeString()}{' '}
                <MutedText plain>· {agoLabel(d.ended_at)}</MutedText>
              </DefinitionEntry>
            )}
            {d.stop_reason != null && <DefinitionEntry label="stop reason">{d.stop_reason}</DefinitionEntry>}
            {d.capability_note != null && (
              <DefinitionEntry label="capability">{d.capability_note}</DefinitionEntry>
            )}
            <DefinitionEntry label="turn ends on">
              {d.turn_end_source}
              {d.turn_end_source === 'quiet-settle' && (
                <MutedText>{" (Houston's judgement, not a report)"}</MutedText>
              )}
            </DefinitionEntry>
          </DefinitionList>
        </DelegationSection>
      )}
    </>
  )
}

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
      <IdentityLine>
        this pane{' '}
        <Emphasis>
          {sessionIdentity(info)}
          {sessionTaskLabel(info) != null && ` · ${sessionTaskLabel(info)}`}
        </Emphasis>
        {atCap && (
          <>
            <InlineSeparator />
            <Emphasis tone="warn">
              {crew.length} of {cap} live children — at the cap
            </Emphasis>
          </>
        )}
      </IdentityLine>
      <DelegationSection>
        <Eyebrow>Children · waiting first</Eyebrow>
        <CrewList>
          {crew.map((c) => {
            const d = c.delegation && needsHumanInput(c) ? { ...c.delegation, state: 'needs_input' as const } : c.delegation
            const secondary = [d?.role, sessionTaskLabel(c)].filter(
              (value): value is string => value != null
            )
            return (
              <CrewButton
                key={c.id}
                identity={sessionIdentity(c)}
                secondary={secondary.join(' · ')}
                tone={d ? stateTone(d) : 'muted'}
                state={d ? stateWord(d) : 'no record'}
                onClick={() => onFocusPane?.(c.id)}
              />
            )
          })}
        </CrewList>
      </DelegationSection>
    </>
  )
}

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
      (a, b) => Number(needsHumanInput(b)) - Number(needsHumanInput(a)) || a.id - b.id
    )
}

function CardHead({ kind, info }: { kind: BadgeKind; info: SessionInfo }): React.JSX.Element {
  const d = info.delegation && needsHumanInput(info) ? { ...info.delegation, state: 'needs_input' as const } : info.delegation
  const waiting = info.children_waiting
  const identity = sessionIdentity(info)
  if (kind === 'orchestrator') {
    return (
      <PopoverHeader
        trailing={
          waiting > 0 && (
            <StatusLabel status="Needs input" variant="pill" tone="waiting">
              {waiting} waiting
            </StatusLabel>
          )
        }
      >
        <StatusGlyph glyph={IconGitFork} role="small" tone={waiting > 0 ? "warn" : "muted"} />
        <PopoverTitle>{identity}</PopoverTitle>
        <PopoverDescription>· {info.live_children} live</PopoverDescription>
      </PopoverHeader>
    )
  }
  return (
    <PopoverHeader
      trailing={
        d && (
          <StatusLabel status="Working" variant="pill" tone={pillTone(d)}>
            {stateWord(d)}
          </StatusLabel>
        )
      }
    >
      <PopoverTitle>{identity}</PopoverTitle>
      {sessionTaskLabel(info) != null && <PopoverDescription>{sessionTaskLabel(info)}</PopoverDescription>}
    </PopoverHeader>
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
    <DelegationSection>
      <DelegationButton
        type="button"
        variant="legacy-focus-lever"
        onClick={() => {
          onDone()
          onFocusPane(target)
        }}
      >
        <Icon glyph={IconEye} role="label" />
        Focus parent
      </DelegationButton>
    </DelegationSection>
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
    <PopoverPanel
      ref={cardRef}
      id={id}
      aria-label={label}
      top={place?.top ?? 0}
      left={place?.left ?? 0}
      visible={place != null}
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
    </PopoverPanel>
  )
}
