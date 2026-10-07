import type { RailAgentRow } from '../../rail/railCardModel'
import type { PrInfo } from '../../../houston/client'
import type { TagInfo } from '../../../houston/generated/TagInfo'
import type { RailCardMode, RailTagDisplay } from '../../../railPrefs'
import type { OpenTagPopoverOptions } from '../../tags/TagPopover'
import { TagCardAffordance } from '../../tags/TagCardAffordance'
import { Icon } from '../Icon'
import { IconClose, IconTag, IconGitPullRequest } from '../../icons'
import { PrLink } from '../PrLink'
import { Tooltip } from '../Tooltip'

export function GridRailTitleRow({
  name,
  tags,
  hasTags,
  tagDisplay,
  pr,
  hasPr,
  hasCheckout,
  cardMode,
  checkoutLabel,
  primary,
  hasRemove,
  gridId,
  onRemove,
  onOpenInspector,
  openTagPopover,
}: {
  name: string
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
    <div className="flex h-5 min-w-0 items-center gap-1.5 text-[length:var(--tr-text-base)] leading-5">
      <span data-testid="grid-name" className="min-w-0 flex-1 truncate">{name}</span>
      {pr?.is_draft && <span className="flex-none rounded border border-[var(--border)] px-1 text-[length:var(--tr-text-xs)] leading-4 text-[var(--text-muted)]">draft</span>}
      {hasTags && tagDisplay === 'dots' && <TagCardAffordance tags={tags} mode="dots" onClick={(anchor) => openTagPopover({ anchor, gridId, view: 'pick' })} />}
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
      {cardMode === 'compact' && hasPr && pr && (
        <PrLink
          href={pr.url}
          onClick={() => primary && onOpenInspector(primary.session.id, 'pull-request')}
          className="flex-none font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]"
        >
          <Icon glyph={IconGitPullRequest} role="small" />#{pr.number}
        </PrLink>
      )}
      {cardMode === 'compact' && hasCheckout && checkoutLabel?.branch && (
        <Tooltip label={checkoutLabel.text}>
          <span className="max-w-24 truncate font-mono text-[length:var(--tr-text-xs)] text-[var(--text-muted)]">{checkoutLabel.branch}</span>
        </Tooltip>
      )}
      {hasRemove && (
        <Tooltip label={`Remove ${name}`}>
        <button
          type="button"
          data-testid="grid-close"
          aria-label={`Remove ${name}`}
          className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)] group-hover:flex"
          onClick={(event) => {
            event.stopPropagation()
            onRemove?.()
          }}
        >
          <Icon glyph={IconClose} role="small" />
        </button>
        </Tooltip>
      )}
    </div>
  )
}
