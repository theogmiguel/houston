import type { TagInfo } from '../../houston/generated/TagInfo'
import { Icon } from '../ui/Icon'
import { IconTag } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import { TAG_POPOVER_CLS } from '../ui/TagPopoverChrome'

export function TagCardAffordance({
  tags,
  onClick,
  disabled = false,
  mode = 'icon',
  onFilter,
}: {
  tags: readonly TagInfo[]
  onClick: (anchor: HTMLElement) => void
  disabled?: boolean
  mode?: 'icon' | 'dots' | 'chips'
  onFilter?: (tag: TagInfo) => void
}): React.JSX.Element | null {
  if (tags.length === 0) return null
  const first = tags[0]
  if (mode === 'chips') return (
    <span data-testid="tag-chips" className={TAG_POPOVER_CLS.cardChips}>
      {tags.slice(0, 2).map((tag) => <Tooltip key={tag.id} label={`Filter by ${tag.name}`}>
        <button type="button" data-testid="tag-chip" className={TAG_POPOVER_CLS.cardChip} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onFilter?.(tag) }}>
          <span className={TAG_POPOVER_CLS.cardDot} style={{ background: tag.color }} />{tag.name}
        </button>
      </Tooltip>)}
      {tags.length > 2 && <Tooltip label={tags.slice(2).map((tag) => tag.name).join(' · ')}><span data-testid="tag-chips-more" className={TAG_POPOVER_CLS.cardMore}>+{tags.length - 2}</span></Tooltip>}
    </span>
  )
  if (mode === 'dots') return (
    <Tooltip label={`Edit tags: ${tags.map((tag) => tag.name).join(' · ')}`}>
      <button type="button" aria-label={`Edit tags: ${tags.map((tag) => tag.name).join(', ')}`} data-testid="rail-tags" className={TAG_POPOVER_CLS.cardDots} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onClick(event.currentTarget) }}>
        {tags.slice(0, 3).map((tag) => <span key={tag.id} className={TAG_POPOVER_CLS.cardDot} style={{ background: tag.color }} />)}
        {tags.length > 3 && <span className={TAG_POPOVER_CLS.cardMore}>+{tags.length - 3}</span>}
      </button>
    </Tooltip>
  )
  return (
    <Tooltip
      label={disabled ? 'Tags are turned off' : `Edit tags: ${tags.map((tag) => tag.name).join(' · ')}`}
    >
      <button
        type="button"
        aria-label={`Tags: ${first.name}${tags.length > 1 ? `, ${tags.length - 1} more` : ''}`}
        aria-disabled={disabled}
        data-testid="tag-card-affordance"
        onClick={(event) => {
          event.stopPropagation()
          onClick(event.currentTarget)
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className={`${TAG_POPOVER_CLS.affordance} ${TAG_POPOVER_CLS.cardIcon}`}
      >
        <span style={{ color: first.color }}>
          <Icon glyph={IconTag} role="small" />
        </span>
        {tags.length > 1 && <span>+{tags.length - 1}</span>}
      </button>
    </Tooltip>
  )
}
