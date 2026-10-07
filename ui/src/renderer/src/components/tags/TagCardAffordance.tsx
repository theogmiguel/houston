import type { TagInfo } from '../../houston/generated/TagInfo'
import { Icon } from '../ui/Icon'
import { IconTag } from '../icons'
import { Tooltip } from '../ui/Tooltip'
import { TAG_POPOVER_CLS } from '../ui/TagPopoverChrome'

export function TagCardAffordance({
  tags,
  onClick,
  disabled = false,
}: {
  tags: readonly TagInfo[]
  onClick: (anchor: HTMLElement) => void
  disabled?: boolean
}): React.JSX.Element | null {
  if (tags.length === 0) return null
  const first = tags[0]
  return (
    <Tooltip
      label={disabled ? 'Tags are turned off' : `${first.name}${tags.length > 1 ? ` · +${tags.length - 1}` : ''}`}
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
        className={TAG_POPOVER_CLS.affordance}
      >
        <span style={{ color: first.color }}>
          <Icon glyph={IconTag} role="small" />
        </span>
        {tags.length > 1 && <span>+{tags.length - 1}</span>}
      </button>
    </Tooltip>
  )
}
