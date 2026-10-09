import type { RailCard } from '../../rail/railCardModel'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { TagInfo } from '../../../houston/generated/TagInfo'
import type { PrInfo } from '../../../houston/client'
import type { AgentActivityMode, RailCardMode, RailCardProperty, RailTagDisplay } from '../../../railPrefs'
import { isRailCardQuiet } from '../../rail/railCardModel'
import { Tooltip } from '../Tooltip'
import { GridRailTitleRow } from './GridRailTitleRow'
import { GridRailCheckoutLine } from './GridRailCheckoutLine'
import { GridRailAgentRows } from './GridRailAgentRows'
import { GridRailHoverCardHost } from './GridRailHoverCardHost'
import { TagCardAffordance } from '../../tags/TagCardAffordance'

function statusDotClass(kind: RailCard['status']['kind']): string {
  if (kind === 'needs-input') return 'bg-[var(--warn)]'
  if (kind === 'working') return 'animate-[spin_1s_linear_infinite] motion-reduce:animate-none border-[1.5px] border-[var(--accent)] border-r-transparent bg-transparent'
  if (kind === 'starting') return 'bg-[var(--accent)]'
  if (kind === 'exited') return 'bg-[var(--stop)]'
  if (kind === 'done') return 'bg-[var(--ok)]'
  return 'bg-[var(--text-faint)]'
}

function StatusDot({ card, now }: { card: RailCard; now: number }): React.JSX.Element {
  const quiet = isRailCardQuiet(card.status, now)
  const state = card.status.kind === 'exited' ? 'stopped' : card.status.kind
  return quiet ? (
    <Tooltip label="No recent update from agent">
    <span data-testid="grid-state-dot" data-state={state} role="img" aria-label="No recent update from agent" className="inline-block size-1.5 flex-none rounded-full border border-[var(--info)] bg-transparent" />
    </Tooltip>
  ) : (
    <span data-testid="grid-state-dot" data-state={state} role="img" className={`inline-block ${card.status.kind === 'working' ? 'size-[9px]' : 'size-2'} flex-none rounded-full ${statusDotClass(card.status.kind)}`} aria-label={state === 'unavailable' ? 'Grid status unavailable' : card.status.label} />
  )
}

function gridRowClassName({ cardMode, hasChipRow, dragging, dragPosition, selected }: {
  cardMode: RailCardMode
  hasChipRow: boolean
  dragging: boolean
  dragPosition: 'before' | 'after' | null
  selected: boolean
}): string {
  return `rail-grid-row group relative min-w-0 rounded-[var(--tr-radius-button)] border border-transparent pr-1.5
    transition-[background-color,border-color] duration-150 ${selected ? 'hover:bg-selected-fill' : 'hover:bg-hover-fill'}
    ${cardMode === 'compact' ? hasChipRow ? 'flex min-h-8 items-start gap-1.5 pl-1 py-1' : 'flex h-8 items-center gap-1.5 pl-1 py-1' : 'flex gap-1.5 pl-1 pt-1.5 pb-[7px]'}
    ${dragging ? 'opacity-50' : ''}
    ${dragPosition ? `after:absolute after:left-1 after:right-1 after:h-px after:bg-[var(--accent)] ${dragPosition === 'before' ? 'after:top-0' : 'after:bottom-0'}` : ''}
    ${selected ? 'border-[var(--border)] bg-selected-fill text-[var(--text-primary)]' : 'bg-transparent text-[var(--text-secondary)]'}`
}

export function GridRailRowView({
  name, workspace, gridId, selected, pinned, tags,
  cardMode, tagDisplay, agentActivity, properties, dragPosition, dragging, dragRefusal, onGridPointerDown,
  onToggleUnread, onFilterTag, jumpNumber, onRemove, onSelect, onContextMenu, onOpenInspector, card, primary,
  checkoutLabel, many, hasUnread, altHeld, hoverPosition, hoverVisible, expanded, now, rowRef, closeTimer,
  openTagPopover, startHover, closeHover, onToggleExpanded, onKeyDown,
}: {
  name: string
  workspace: string
  gridId: string
  selected: boolean
  pinned: boolean
  tags: readonly TagInfo[]
  cardMode: RailCardMode
  tagDisplay: RailTagDisplay
  agentActivity: AgentActivityMode
  properties: readonly RailCardProperty[]
  dragPosition: 'before' | 'after' | null
  dragging: boolean
  dragRefusal: boolean
  onGridPointerDown?: (event: React.PointerEvent, workspace: string, gridId: string) => void
  onToggleUnread?: () => void
  onFilterTag?: (tag: TagInfo) => void
  jumpNumber?: number
  onRemove?: () => void
  onSelect: () => void
  onContextMenu?: (event: React.MouseEvent) => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  card: RailCard
  primary?: RailAgentRow
  checkoutLabel: { branch: string | null; text: string } | null
  many: boolean
  hasUnread: boolean
  altHeld: boolean
  hoverPosition: { left: number; top: number } | null
  hoverVisible: boolean
  expanded: boolean
  now: number
  rowRef: React.RefObject<HTMLDivElement | null>
  closeTimer: React.RefObject<ReturnType<typeof setTimeout> | null>
  openTagPopover: (options: import('../../tags/TagPopover').OpenTagPopoverOptions) => void
  startHover: () => void
  closeHover: () => void
  onToggleExpanded: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const pr = card.pr?.pr ?? null
  const hasChipRow = properties.includes('tags') && tagDisplay === 'chips' && tags.length > 0
  const openTags = (anchor: HTMLElement): void => openTagPopover({ anchor, gridId, view: 'pick' })
  return (
    <Tooltip label={dragRefusal ? 'Grids can only be reordered within the same workspace' : null} className="block">
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        data-testid="grid-row"
        data-grid-id={gridId}
        data-rail-grid-id={gridId}
        data-rail-workspace={workspace}
        data-drag-position={dragPosition ?? undefined}
        data-selected={selected ? 'true' : undefined}
        data-card-mode={cardMode}
        aria-current={selected ? 'true' : undefined}
        aria-label={`${name}, ${card.status.label}`}
        className={gridRowClassName({ cardMode, hasChipRow, dragging, dragPosition, selected })}
        onPointerDown={(event) => onGridPointerDown?.(event, workspace, gridId)}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        onMouseEnter={startHover}
        onMouseLeave={closeHover}
      >
        <GridRailUnreadToggle card={card} now={now} cardMode={cardMode} hasUnread={hasUnread} onToggleUnread={onToggleUnread} />
        <div className={`flex min-w-0 flex-1 flex-col ${cardMode === 'compact' && !hasChipRow ? 'justify-center' : 'gap-[5px]'}`}>
          <GridRailTitleRow name={name} unread={properties.includes('unread') && hasUnread} pinned={pinned} tags={tags} hasTags={properties.includes('tags')} tagDisplay={tagDisplay} pr={pr} hasPr={properties.includes('pr')} hasCheckout={properties.includes('checkout')} cardMode={cardMode} checkoutLabel={checkoutLabel} many={many} agentCount={card.agents.length} primary={primary} hasRemove={Boolean(onRemove)} gridId={gridId} onRemove={onRemove} onOpenInspector={onOpenInspector} openTagPopover={openTagPopover} />
          <GridRailCheckout cardMode={cardMode} hasCheckout={properties.includes('checkout')} label={checkoutLabel} pr={pr} hasPr={properties.includes('pr')} hasDiff={properties.includes('diff')} diff={card.diff} primary={primary} onOpenInspector={onOpenInspector} />
          {hasChipRow && <div className="flex min-h-4 items-center text-[length:var(--tr-text-xs)]"><TagCardAffordance tags={tags} mode="chips" onClick={openTags} onFilter={onFilterTag} /></div>}
          <GridRailAgentRows agents={card.agents} cardMode={cardMode} agentActivity={agentActivity} properties={properties} expanded={expanded} onToggleExpanded={onToggleExpanded} now={now} />
        </div>
        <GridRailJumpNumber number={jumpNumber} altHeld={altHeld} />
      </div>
      {hoverPosition && <GridRailHoverCardHost card={card} tags={tags} position={hoverPosition} visible={hoverVisible} closeTimer={closeTimer} scheduleClose={closeHover} onOpenInspector={onOpenInspector} />}
    </Tooltip>
  )
}

function GridRailUnreadToggle({ card, now, cardMode, hasUnread, onToggleUnread }: {
  card: RailCard
  now: number
  cardMode: RailCardMode
  hasUnread: boolean
  onToggleUnread?: () => void
}): React.JSX.Element {
  const label = hasUnread ? 'Mark as read' : 'Mark as unread'
  return <Tooltip label={label}>
    <button type="button" aria-label={label} data-testid="grid-unread-toggle" className={`relative flex w-4 flex-none justify-center ${cardMode === 'compact' ? 'items-start pt-1' : 'h-5 items-start pt-[5px]'}`} onClick={(event) => { event.stopPropagation(); onToggleUnread?.() }}>
      <StatusDot card={card} now={now} />
    </button>
  </Tooltip>
}

function GridRailCheckout({ cardMode, hasCheckout, label, pr, hasPr, hasDiff, diff, primary, onOpenInspector }: {
  cardMode: RailCardMode
  hasCheckout: boolean
  label: { branch: string | null; text: string } | null
  pr: PrInfo | null
  hasPr: boolean
  hasDiff: boolean
  diff: RailCard['diff']
  primary?: RailAgentRow
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element | null {
  if (cardMode !== 'detailed' || !hasCheckout || !label) return null
  return <GridRailCheckoutLine label={label} pr={hasPr ? pr : null} diff={hasDiff ? diff : null} onOpenInspector={() => primary && onOpenInspector(primary.session.id, 'pull-request')} />
}

function GridRailJumpNumber({ number, altHeld }: { number?: number; altHeld: boolean }): React.JSX.Element | null {
  if (number == null) return null
  return <span aria-hidden data-testid="rail-jump-number" className={`rail-jump absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[var(--accent)] ${altHeld ? '' : 'hidden'}`}>{number}</span>
}
