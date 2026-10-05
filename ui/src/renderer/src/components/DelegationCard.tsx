import { useSession, useSessionFamily } from '../sessionsStore'
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DelegationInfo } from '../houston/generated/DelegationInfo'
import type { SessionInfo } from '../houston/client'
import { Icon } from './Icon'
import { IconCornerDownRight, IconGitFork } from './icons'
import { HOVER_DELAY_MS, Tooltip } from './Tooltip'
import { Button, Caption } from './ui'

const DelegationPanel = lazy(() => import('./DelegationPanel'))

export interface PaneRoster {
  sessions: ReadonlyMap<number, SessionInfo>
  maxLiveChildren: number | null
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

// `unknown` is ignorance, not a verdict: the daemon restarted mid-flight, so
// nobody knows how the work ended. Saying "failed" would be a claim about the
// child rather than about Houston.
export function stateWord(d: DelegationInfo): string {
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

export function ProvisionalMarker(): React.JSX.Element {
  return (
    <Tooltip label="released on a stop with no sub-agent evidence; a correction may follow">
      <Caption variant="provisional">
        may be corrected
      </Caption>
    </Tooltip>
  )
}

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

export function HeaderDelegationBadge({
  kind,
  info: infoProp,
  roster: rosterProp,
  onFocusPane,
  onDeliverNow,
  children,
  className,
  onSelect
}: {
  children?: React.ReactNode
  className?: string
  onSelect?: () => void
  kind: BadgeKind
  info: SessionInfo
  roster?: PaneRoster
  onFocusPane?: (id: number) => void
  onDeliverNow?: (session: number) => void
}): React.JSX.Element {
  const info = useSession(infoProp.id, infoProp) ?? infoProp
  const family = useSessionFamily(info.id, rosterProp?.sessions)
  const roster = rosterProp ? { ...rosterProp, sessions: family } : undefined
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
    <Button
      variant="badge"
      ref={btnRef}
      type="button"
      data-testid={kind === 'origin' ? 'origin-badge' : 'orchestrator-badge'}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      className={className}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={openAfterDelay}
      onPointerLeave={leave}
      onFocus={() => setOpen(true)}
      onClick={(e) => {
        e.stopPropagation()
        if (onSelect) {
          onSelect()
          close()
        } else {
          pinnedRef.current = !pinnedRef.current
          setOpen(true)
        }
      }}
    >
      {children ?? <>
      <Icon
        glyph={kind === 'origin' ? IconCornerDownRight : IconGitFork}
        role="label"
        className={glyphWarn ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}
      />
      <BadgeContent kind={kind} info={info} selfName={selfName} />
      </>}
    </Button>
  )
  return (
    <>
      <Tooltip label={open ? null : label}>{badge}</Tooltip>
      {open &&
        createPortal(
          <Suspense fallback={null}>
            <DelegationPanel
              cardRef={cardRef}
              id={id}
              label={label}
              anchorRef={btnRef}
              kind={kind}
              info={info}
              roster={roster}
              onFocusPane={onFocusPane}
              onDeliverNow={onDeliverNow}
              onClose={close}
              onPointerEnter={cancelTimer}
              onPointerLeave={leave}
            />
          </Suspense>,
          document.body
        )}
    </>
  )
}
