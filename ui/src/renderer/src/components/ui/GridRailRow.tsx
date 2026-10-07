import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo } from '../../houston/client'
import type { SessionCheckout } from '../../houston/generated/SessionCheckout'
import type { TagInfo } from '../../houston/generated/TagInfo'
import { useSessionsSelector, shallowArrayEqual } from '../../sessionsStore'
import { formatCheckout } from '../checkout/formatCheckout'
import { buildRailCard, type CheckoutIdentity } from '../rail/railCardModel'
import type { AgentActivityMode, RailCardMode, RailCardProperty } from '../../railPrefs'
import type { RailDiffTotals } from '../git/useRailGitFacts'
import type { RailPrState } from '../git/railPrCache'
import { useTagPopover } from '../tags/TagPopover'
import { GridRailRowView } from './rail/GridRailRowView'

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
  agentActivity?: AgentActivityMode
  properties?: readonly RailCardProperty[]
  unread?: boolean
  dragPosition?: 'before' | 'after' | null
  dragging?: boolean
  dragRefusal?: boolean
  onGridPointerDown?: (event: React.PointerEvent, workspace: string, gridId: string) => void
  onToggleUnread?: () => void
  jumpNumber?: number
  onRemove?: () => void
  onSelect: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}

function checkoutFor(identity: CheckoutIdentity): { checkout: SessionCheckout | null; remoteHost?: string } {
  if (identity.kind === 'remote') return { checkout: null, remoteHost: identity.host }
  const kind = identity.kind === 'worktree'
    ? { worktree: { slug: identity.slug } }
    : identity.kind === 'primary' ? 'primary' : 'folder'
  return { checkout: { root: identity.root, kind, branch: 'branch' in identity ? identity.branch : null, head: null } }
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
  agentActivity = 'compact',
  properties = ['status', 'unread', 'checkout', 'pr', 'diff', 'task', 'inline-agents'],
  jumpNumber,
  unread,
  dragPosition = null,
  dragging = false,
  dragRefusal = false,
  onGridPointerDown,
  onToggleUnread,
  onSelect,
  onContextMenu,
  onOpenInspector,
  onRemove,
}: GridRailRowProps): React.JSX.Element {
  const [hoverPosition, setHoverPosition] = useState<{ left: number; top: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [altHeld, setAltHeld] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rowRef = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { open: openTagPopover } = useTagPopover()
  const sessions = useSessionsSelector(
    (store) => paneIds.flatMap((id) => store.get(id) ?? []),
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
  const identity = card.checkouts[0]
  const formattedCheckout = identity
    ? formatCheckout(checkoutFor(identity).checkout, {
      remoteHost: identity.kind === 'remote' ? identity.host : undefined,
    })
    : null
  const identityBranch = identity && identity.kind !== 'remote' && identity.kind !== 'folder' ? identity.branch : null
  const checkoutLabel = formattedCheckout && identityBranch
    ? { ...formattedCheckout, text: identityBranch }
    : formattedCheckout
  const many = card.agents.length > 1
  const hasUnread = unread ?? card.agents.some((agent) => agent.unread)
  const startHover = (): void => {
    if (cardMode !== 'compact') return
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    hoverTimer.current = setTimeout(() => {
      const rect = rowRef.current?.getBoundingClientRect()
      if (rect) {
        setHoverPosition({
          left: Math.min(rect.right + 12, window.innerWidth - 316),
          top: Math.max(8, Math.min(rect.top, window.innerHeight - 280)),
        })
      }
    }, 150)
  }
  const closeHover = (): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    closeTimer.current = setTimeout(() => setHoverPosition(null), 0)
  }
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setAltHeld(true)
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setAltHeld(false)
    }
    const blur = (): void => setAltHeld(false)
    const ageTimer = window.setInterval(() => setNow(Date.now()), 30_000)
    const jump = (event: KeyboardEvent): void => {
      if (
        !event.altKey ||
        jumpNumber == null ||
        event.key !== String(jumpNumber) ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) return
      event.preventDefault()
      onSelect()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keydown', jump)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keydown', jump)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.clearInterval(ageTimer)
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [jumpNumber, onSelect])
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = [...(rowRef.current?.parentElement?.querySelectorAll<HTMLElement>('[data-testid="grid-row"]') ?? [])]
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
      agentActivity={agentActivity}
      properties={properties}
      dragPosition={dragPosition}
      dragging={dragging}
      dragRefusal={dragRefusal}
      onGridPointerDown={onGridPointerDown}
      onToggleUnread={onToggleUnread}
      jumpNumber={jumpNumber}
      onRemove={onRemove}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onOpenInspector={onOpenInspector}
      card={card}
      primary={primary}
      checkoutLabel={checkoutLabel}
      many={many}
      hasUnread={hasUnread}
      altHeld={altHeld}
      hoverPosition={hoverPosition}
      expanded={expanded}
      now={now}
      rowRef={rowRef}
      closeTimer={closeTimer}
      openTagPopover={openTagPopover}
      startHover={startHover}
      closeHover={closeHover}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onKeyDown={onKeyDown}
    />
  )
}
