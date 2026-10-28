import type { RailAgentRow } from '../../rail/railCardModel'
import type { PrInfo } from '../../../houston/client'
import type { TagInfo } from '../../../houston/generated/TagInfo'
import type { RailCardMode, RailTagDisplay } from '../../../railPrefs'
import type { OpenTagPopoverOptions } from '../../tags/TagPopover'
import { TagCardAffordance } from '../../tags/TagCardAffordance'
import { Icon } from '../Icon'
import { IconClose, IconTag } from '../../icons'
import { PrLink } from '../PrLink'
import { Tooltip } from '../Tooltip'

export function GridRailTitleRow({
  name,
  unread = false,
  tags,
  hasTags,
  tagDisplay,
  pr,
  hasPr,
  hasCheckout,
  checkoutLabel,
  primary,
  hasRemove,
  gridId,
  onRemove,
  onOpenInspector,
  openTagPopover,
}: {
  name: string
  // Unread is carried by the title, so the status column keeps a single dot and amber stays reserved for needs-input.
  unread?: boolean
  pinned: boolean
  tags: readonly TagInfo[]
  hasTags: boolean
  tagDisplay: RailTagDisplay
  pr: PrInfo | null
  hasPr: boolean
  hasCheckout: boolean
  cardMode: RailCardMode
  checkoutLabel: { branch: string | null; text: string } | null
  many: boolean
  agentCount: number
  primary?: RailAgentRow
  hasRemove: boolean
  gridId: string
  onRemove?: () => void
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
  openTagPopover: (options: OpenTagPopoverOptions) => void
}): React.JSX.Element {
  const tagNames = tags.map((tag) => tag.name)
  return (
    <div data-testid="grid-caption" className={`group/caption flex h-[var(--h-grid-caption)] min-w-0 items-center gap-[var(--space-2)] pr-[var(--space-2)] text-[length:var(--tr-text-label-size)] leading-[var(--tr-text-label-leading)] text-[var(--text-muted)] ${hasRemove ? 'group-hover/grid:pr-5 group-focus-within/grid:pr-5' : ''}`}>
      <span data-testid="grid-name" className={`min-w-0 truncate font-semibold ${unread ? 'text-[var(--text-primary)]' : ''} group-hover/grid:text-[var(--text-primary)] group-focus-within/grid:text-[var(--text-primary)]`}>{name}</span>
      {unread && <span role="img" aria-label="Unread" data-testid="grid-unread-pip" className="size-1.5 flex-none rounded-full bg-[var(--accent)]" />}
      {hasCheckout && checkoutLabel?.branch && (
        <Tooltip label={checkoutLabel.text}>
          <span className="min-w-0 truncate font-mono [font-size:var(--tr-text-label-size)] text-[var(--text-muted)]">{checkoutLabel.branch}</span>
        </Tooltip>
      )}
      <span aria-hidden className="min-w-0 flex-1" />
      <span className="hidden flex-none items-center gap-[var(--space-2)] group-hover/grid:flex group-focus-within/grid:flex">
        {hasTags && tags.length > 0 && tagDisplay === 'dots' && <TagCardAffordance tags={tags} mode="dots" onClick={(anchor) => openTagPopover({ anchor, gridId, view: 'pick' })} />}
        {hasTags && tagDisplay === 'icon' && tags.length > 0 && (
          <Tooltip label={`Edit tags: ${tagNames.join(' · ')}`}>
            <button
              type="button"
              aria-label={`Edit tags: ${tagNames.join(', ')}`}
              data-testid="rail-tags"
              className="inline-flex flex-none items-center gap-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={(event) => {
                event.stopPropagation()
                openTagPopover({ anchor: event.currentTarget, gridId, view: 'pick' })
              }}
            >
              <span data-testid="rail-tag-glyph" style={{ color: tags[0].color }}><Icon glyph={IconTag} role="small" /></span>
              {tags.length > 1 && <span className="text-[length:var(--tr-text-xs)]">+{tags.length - 1}</span>}
            </button>
          </Tooltip>
        )}
        {hasPr && pr && <GridRailPrChip pr={pr} primary={primary} onOpenInspector={onOpenInspector} />}
        {hasRemove && (
          <Tooltip label="Close grid">
            <button
              type="button"
              data-testid="grid-close"
              aria-label={`Close grid ${name}`}
              className="flex size-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-primary)]"
              onClick={(event) => { event.stopPropagation(); onRemove?.() }}
            >
              <Icon glyph={IconClose} role="small" />
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  )
}

function GridRailPrChip({ pr, primary, onOpenInspector }: {
  pr: PrInfo
  primary?: RailAgentRow
  onOpenInspector: (paneId: number, tab: 'changes' | 'pull-request') => void
}): React.JSX.Element {
  return (
        <PrLink
          aria-label={`Open pull request #${pr.number}, checks ${pr.checks || 'unavailable'}`}
          href={pr.url}
          onClick={() => primary && onOpenInspector(primary.session.id, 'pull-request')}
          className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]"
        >
          {pr.is_draft && <span>Draft </span>}#{pr.number}
          <span role="img" aria-label={`Checks ${pr.checks || 'unavailable'}`} className="size-1.5 rounded-full" style={{ background: `var(--${pr.is_draft ? 'text-muted' : pr.checks === 'passing' ? 'ok' : pr.checks === 'failing' ? 'stop' : 'warn'})` }} />
        </PrLink>
  )
}
