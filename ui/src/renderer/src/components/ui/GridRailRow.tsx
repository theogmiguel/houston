import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo } from '../../houston/client'
import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { useSessionsSelector, shallowArrayEqual } from '../../sessionsStore'
import { formatCheckout } from '../checkout/formatCheckout'
import { buildRailCard, type CheckoutIdentity } from '../rail/railCardModel'
import type { AgentActivityMode, RailCardMode, RailCardProperty, RailTagDisplay } from '../../railPrefs'
import type { RailDiffTotals } from '../git/useRailGitFacts'
import type { RailPrState } from '../git/railPrCache'
import { useTagPopover } from '../tags/TagPopover'
import { GridRailRowView } from './rail/GridRailRowView'

let railHoverWarmUntil = 0

export interface GridRailRowProps {
  name: string
  workspace: string
  gridId: string
  selected: boolean
  pinned?: boolean
  paneIds: number[]
  tags?: readonly TagInfo[]
  fallbackSessions: readonly SessionInfo[]
  branches: ReadonlyMap<number, string>
  diffByDir: ReadonlyMap<string, RailDiffTotals>
  prByDir: ReadonlyMap<string, RailPrState>
  cardMode?: RailCardMode
  tagDisplay?: RailTagDisplay
  agentActivity?: AgentActivityMode
  properties?: readonly RailCardProperty[]
  unread?: boolean
  dragPosition?: 'before' | 'after' | null
  dragging?: boolean
  /** Why a drag from this row is refused (shown as a tooltip), or null when it is allowed. */
  dragRefusal?: string | null
  onGridPointerDown?: (event: React.PointerEvent, workspace: string, gridId: string) => void
  onToggleUnread?: () => void
  onFilterTag?: (tag: TagInfo) => void
  jumpNumber?: number
  onRemove?: () => void
  expanded?: boolean
  onToggleExpanded?: () => void
  onFocusPane?: (paneId: number) => void
  onSelect: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  /** True while this grid's context menu is open; the hover preview stays closed. */
  menuOpen?: boolean
  /** True while another surface (any context menu, a grid drag) owns the pointer; the preview stays closed and an open one closes. */
  hoverSuppressed?: boolean
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}

function checkoutFor(identity: CheckoutIdentity): { checkout: SessionCheckout | null; remoteHost?: string } {
  if (identity.kind === 'remote') return { checkout: null, remoteHost: identity.host }
  const kind = identity.kind === 'worktree'
    ? { worktree: { slug: identity.slug } }
    : identity.kind === 'primary' ? 'primary' : 'folder'
  return { checkout: { root: identity.root, kind, branch: 'branch' in identity ? identity.branch : null, head: null } }
}

function railCheckoutLabel(identity: CheckoutIdentity | undefined): ReturnType<typeof formatCheckout> | null {
  if (!identity) return null
  const formatted = formatCheckout(checkoutFor(identity).checkout, {
    remoteHost: identity.kind === 'remote' ? identity.host : undefined,
  })
  const branch = identity.kind !== 'remote' && identity.kind !== 'folder' ? identity.branch : null
  return formatted && branch ? { ...formatted, text: branch } : formatted
}

// Alt held down reveals the card numbers; losing window focus ends the hold.
function useAltHeld(): boolean {
  const [altHeld, setAltHeld] = useState(false)
  useEffect(() => {
    const track = (held: boolean) => (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setAltHeld(held)
    }
    const down = track(true)
    const up = track(false)
    const blur = (): void => setAltHeld(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
  return altHeld
}

export function GridRailRow({
  name,
  workspace,
  gridId,
  selected,
  pinned = false,
  paneIds,
  tags = [],
  fallbackSessions,
  branches,
  diffByDir,
  prByDir,
  cardMode = 'detailed',
  tagDisplay = 'chips',
  agentActivity = 'compact',
  properties = ['status', 'unread', 'checkout', 'pr', 'diff', 'tags', 'inline-agents'],
  jumpNumber,
  unread,
  dragPosition = null,
  dragging = false,
  dragRefusal = null,
  onGridPointerDown,
  onToggleUnread,
  onFilterTag,
  onSelect,
  onFocusPane,
  expanded: controlledExpanded,
  onToggleExpanded: controlledToggle,
  onContextMenu,
  menuOpen,
  hoverSuppressed = false,
  onOpenInspector,
  onRemove,
}: GridRailRowProps): React.JSX.Element {
  const [hoverPosition, setHoverPosition] = useState<{ left: number; top: number } | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const altHeld = useAltHeld()
  const [now, setNow] = useState(() => Date.now())
  const rowRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverMounted = useRef(false)
  const suppressed = Boolean(menuOpen) || hoverSuppressed
  const suppressedRef = useRef(suppressed)
  useEffect(() => {
    suppressedRef.current = suppressed
  })
  const { open: openTagPopover } = useTagPopover()
  // Descendants outside the grid still lift an idle orchestrator's status.
  const sessions = useSessionsSelector(
    (store) => {
      const picked = paneIds.flatMap((id) => store.get(id) ?? [])
      const ids = new Set(picked.map((session) => session.id))
      for (let grew = true; grew;) {
        grew = false
        for (const session of store.values()) {
          if (session.spawned_by == null || ids.has(session.id) || !ids.has(session.spawned_by)) continue
          ids.add(session.id)
          picked.push(session)
          grew = true
        }
      }
      return picked
    },
    shallowArrayEqual,
    fallbackSessions.filter((session) => paneIds.includes(session.id)),
  )
  const card = useMemo(
    () => buildRailCard({
      gridId,
      workspace,
      title: name,
      pinned,
      paneIds,
      sessions,
      branches,
      diffByDir,
      prByDir,
    }),
    [gridId, workspace, name, pinned, paneIds, sessions, branches, diffByDir, prByDir],
  )
  const primary = card.agents[0]
  const checkoutLabel = railCheckoutLabel(card.checkouts[0])
  const many = card.agents.length > 1
  const hasUnread = unread ?? card.agents.some((agent) => agent.unread)
  const startHover = (): void => {
    if (suppressedRef.current) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      const rect = rowRef.current?.getBoundingClientRect()
      if (rect) {
        hoverMounted.current = true
        setHoverPosition({
          left: rect.right + 6,
          top: rect.top,
        })
        setHoverVisible(true)
      }
    }, Date.now() < railHoverWarmUntil ? 0 : 150)
  }
  const closeHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (hoverVisible) railHoverWarmUntil = Date.now() + 400
    setHoverVisible(false)
    closeTimer.current = setTimeout(() => { hoverMounted.current = false; setHoverPosition(null) }, 150)
  }
  useEffect(() => {
    if (!suppressed) return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    if (closeTimer.current) clearTimeout(closeTimer.current)
    hoverMounted.current = false
    setHoverVisible(false)
    setHoverPosition(null)
  }, [suppressed])
  useEffect(() => {
    const hideOnScroll = (): void => {
      if (!hoverTimer.current && !hoverMounted.current) return
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      hoverTimer.current = null
      if (closeTimer.current) clearTimeout(closeTimer.current)
      setHoverVisible(false)
      closeTimer.current = setTimeout(() => { hoverMounted.current = false; setHoverPosition(null) }, 150)
    }
    document.addEventListener('scroll', hideOnScroll, true)
    return () => {
      document.removeEventListener('scroll', hideOnScroll, true)
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])
  // Its own effect with no dependencies: a re-render must never restart the 30 s tick.
  useEffect(() => {
    const ageTimer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(ageTimer)
  }, [])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = [...((rowRef.current?.closest('[data-rail-grid-list]') ?? rowRef.current?.parentElement)?.querySelectorAll<HTMLElement>('[data-testid="grid-row"]') ?? [])]
      const index = rows.indexOf(rowRef.current!)
      rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }

  return (
    <GridRailRowView
      name={name}
      workspace={workspace}
      gridId={gridId}
      selected={selected}
      pinned={pinned}
      tags={tags}
      cardMode={cardMode}
      tagDisplay={tagDisplay}
      agentActivity={agentActivity}
      properties={properties}
      dragPosition={dragPosition}
      dragging={dragging}
      dragRefusal={dragRefusal}
      onGridPointerDown={onGridPointerDown}
      onToggleUnread={onToggleUnread}
      onFilterTag={onFilterTag}
      jumpNumber={jumpNumber}
      onRemove={onRemove}
      onSelect={onSelect}
      onFocusPane={onFocusPane}
      onContextMenu={onContextMenu}
      onOpenInspector={onOpenInspector}
      card={card}
      primary={primary}
      checkoutLabel={checkoutLabel}
      many={many}
      hasUnread={hasUnread}
      altHeld={altHeld}
      hoverPosition={hoverPosition}
      hoverVisible={hoverVisible}
      expanded={controlledExpanded ?? expanded}
      now={now}
      rowRef={rowRef}
      openTagPopover={openTagPopover}
      startHover={startHover}
      closeHover={closeHover}
      onToggleExpanded={controlledToggle ?? (() => setExpanded((value) => !value))}
      onKeyDown={onKeyDown}
    />
  )
}
