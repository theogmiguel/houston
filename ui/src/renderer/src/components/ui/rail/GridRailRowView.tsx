import type { RailCard } from '../../rail/railCardModel'
import type { RailAgentRow } from '../../rail/railCardModel'
import type { TagInfo } from '../../../houston/generated/TagInfo'
import type { AgentActivityMode, RailCardMode, RailCardProperty, RailTagDisplay } from '../../../railPrefs'
import { Tooltip } from '../Tooltip'
import { StatusGlyph, statusGlyphState } from '../StatusGlyph'
import { GridRailTitleRow } from './GridRailTitleRow'
import { GridRailAgentRows } from './GridRailAgentRows'
import { GridRailCheckoutLine } from './GridRailCheckoutLine'
import { GridRailNoteLine, newestNote } from './GridRailNoteLine'
import { GridRailHoverCardHost } from './GridRailHoverCardHost'
import { TagCardAffordance } from '../../tags/TagCardAffordance'

function StatusDot({ card }: { card: RailCard }): React.JSX.Element {
  const state = card.status.kind === 'exited' ? 'stopped' : card.status.kind
  return (
    <span data-testid="grid-state-dot" data-state={state} className="inline-flex flex-none">
      <StatusGlyph state={statusGlyphState(card.status.kind)} label={state === 'unavailable' ? 'Grid status unavailable' : card.status.label} />
    </span>
  )
}

function gridRowClassName({ dragging, dragPosition }: {
  cardMode: RailCardMode
  hasChipRow: boolean
  dragging: boolean
  dragPosition: 'before' | 'after' | null
  selected: boolean
}): string {
  return `rail-grid-block group/grid relative min-w-0
    ${dragging ? 'opacity-50' : ''}
    ${dragPosition ? `after:absolute after:left-1 after:right-1 after:h-px after:bg-[var(--accent)] ${dragPosition === 'before' ? 'after:top-0' : 'after:bottom-0'}` : ''}`
}

export function GridRailRowView({
  name, workspace, gridId, selected, pinned, tags,
  cardMode, tagDisplay, properties, dragPosition, dragging, dragRefusal, onGridPointerDown,
  onToggleUnread, onFilterTag, jumpNumber, onRemove, onSelect, onFocusPane, onContextMenu, onOpenInspector, onClearNote, card, primary,
  checkoutLabel, many, hasUnread, altHeld, hoverPosition, hoverVisible, now, rowRef,
  openTagPopover, startHover, closeHover, onKeyDown,
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
  dragRefusal: string | null
  onGridPointerDown?: (event: React.PointerEvent, workspace: string, gridId: string) => void
  onToggleUnread?: () => void
  onFilterTag?: (tag: TagInfo) => void
  jumpNumber?: number
  onRemove?: () => void
  onSelect: () => void
  onFocusPane?: (paneId: number) => void
  onContextMenu?: (event: React.MouseEvent) => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  onClearNote?: (session: number) => void
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
  openTagPopover: (options: import('../../tags/TagPopover').OpenTagPopoverOptions) => void
  startHover: () => void
  closeHover: () => void
  onToggleExpanded: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
}): React.JSX.Element {
  const pr = card.pr?.pr ?? null
  const note = cardMode === 'detailed' ? newestNote(card.agents) : null
  const hasChipRow = properties.includes('tags') && tagDisplay === 'chips' && tags.length > 0
  const openTags = (anchor: HTMLElement): void => openTagPopover({ anchor, gridId, view: 'pick' })
  return (
    <Tooltip label={dragRefusal} className="block">
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
        <div className="relative flex min-w-0 items-center">
          <div className="absolute left-0 top-0 flex h-[var(--h-grid-caption)] w-[var(--space-5)] items-center justify-center opacity-0 [transition:opacity_0.12s] group-hover/grid:opacity-100 group-focus-within/grid:opacity-100">
            <GridRailUnreadToggle card={card} cardMode={cardMode} hasUnread={hasUnread} enabled={properties.includes('unread')} onToggleUnread={onToggleUnread} />
          </div>
          <div className="min-w-0 flex-1 pl-[var(--space-6)]">
            <GridRailTitleRow name={name} unread={properties.includes('unread') && hasUnread} pinned={pinned} tags={tags} hasTags={properties.includes('tags')} tagDisplay={tagDisplay} pr={pr} hasPr={properties.includes('pr')} hasCheckout={properties.includes('checkout')} cardMode={cardMode} checkoutLabel={checkoutLabel} many={many} agentCount={card.agents.length} primary={primary} hasRemove={Boolean(onRemove)} gridId={gridId} onRemove={onRemove} onOpenInspector={onOpenInspector} openTagPopover={openTagPopover} />
          </div>
        </div>
        {properties.includes('checkout') && checkoutLabel && (
          <div className="hidden min-h-4 items-center pl-[var(--space-6)] group-hover/grid:flex group-focus-within/grid:flex">
            <GridRailCheckoutLine label={checkoutLabel} pr={properties.includes('pr') ? pr : null} diff={properties.includes('diff') ? card.diff : null} onOpenInspector={() => primary && onOpenInspector(primary.session.id, 'pull-request')} />
          </div>
        )}
        {hasChipRow && <div className="hidden min-h-4 items-center pl-[var(--space-6)] text-[length:var(--tr-text-xs)] group-hover/grid:flex group-focus-within/grid:flex"><TagCardAffordance tags={tags} mode="chips" onClick={openTags} onFilter={onFilterTag} /></div>}
        {note && <GridRailNoteLine note={note} now={now} onClear={onClearNote} />}
        {cardMode === 'detailed' && card.agents.length === 0 && <div data-testid="grid-no-agents" className="pl-[var(--space-6)] text-[length:var(--tr-text-xs)] leading-4 text-[var(--text-muted)]">No agents</div>}
        <GridRailAgentRows
          agents={properties.includes('inline-agents') ? card.agents : []}
          selectedSessionId={selected ? primary?.session.id : undefined}
          now={now}
          onFocusPane={(paneId) => { onSelect(); onFocusPane?.(paneId) }}
        />
        <GridRailJumpNumber number={jumpNumber} altHeld={altHeld} />
      </div>
      {hoverPosition && <GridRailHoverCardHost card={card} tags={tags} position={hoverPosition} visible={hoverVisible} />}
    </Tooltip>
  )
}

function GridRailUnreadToggle({ card, cardMode, hasUnread, enabled, onToggleUnread }: {
  card: RailCard
  cardMode: RailCardMode
  hasUnread: boolean
  // Without the `unread` property nothing on the card shows read state, so the dot offers no toggle.
  enabled: boolean
  onToggleUnread?: () => void
}): React.JSX.Element {
  if (!enabled) {
    return <span data-testid="grid-status-dot-static" className={`relative flex w-4 flex-none justify-center ${cardMode === 'compact' ? 'items-start pt-1' : 'h-5 items-start pt-[5px]'}`}>
      <StatusDot card={card} />
    </span>
  }
  const label = hasUnread ? 'Mark as read' : 'Mark as unread'
  return <Tooltip label={label}>
    <button type="button" aria-label={label} data-testid="grid-unread-toggle" className={`relative flex w-4 flex-none justify-center ${cardMode === 'compact' ? 'items-start pt-1' : 'h-5 items-start pt-[5px]'}`} onClick={(event) => { event.stopPropagation(); onToggleUnread?.() }}>
      <StatusDot card={card} />
    </button>
  </Tooltip>
}

function GridRailJumpNumber({ number, altHeld }: { number?: number; altHeld: boolean }): React.JSX.Element | null {
  if (number == null) return null
  return <span aria-hidden data-testid="rail-jump-number" className={`rail-jump absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[var(--accent)] ${altHeld ? '' : 'hidden'}`}>{number}</span>
}
