import { IconClose } from './icons'
import { FOCUS_HALO } from './shadowChrome'
import { HIT_TARGET_28 } from './hitTarget'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

export type ChipVariant = 'state' | 'provider' | 'count' | 'compound' | 'removable'
export type ChipTone = 'default' | 'info' | 'success' | 'warning' | 'danger'

export interface ChipProps {
  variant: ChipVariant
  label?: string
  tone?: ChipTone
  icon?: React.ReactNode
  count?: number
  emptySetLabel?: string
  selected?: boolean
  disabled?: boolean
  disabledReason?: string
  loading?: boolean
  onClick?: () => void
  onRemove?: () => void
  className?: string
}

const TONE_CLASS: Record<ChipTone, string> = {
  default: 'bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border)]',
  info: 'bg-[var(--status-doing-bg)] text-[var(--status-doing-text)] border-transparent',
  success: 'bg-[var(--status-done-bg)] text-[var(--status-done-text)] border-transparent',
  warning: 'bg-[var(--status-todo-bg)] text-[var(--status-todo-text)] border-transparent',
  danger: 'bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] border-transparent'
}

function Spinner({ size = 10 }: { size?: number }): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block flex-none animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
    />
  )
}

export function Chip({
  variant,
  label,
  tone = 'default',
  icon,
  count,
  emptySetLabel = 'None',
  selected = false,
  disabled = false,
  disabledReason,
  loading = false,
  onClick,
  onRemove,
  className = ''
}: ChipProps): React.JSX.Element {
  const isPressable = variant === 'removable' || !!onClick
  const shapeRadius = isPressable ? 'rounded-[var(--tr-radius-pill)]' : 'rounded-[var(--tr-radius-sm)]'

  let content: React.ReactNode
  // `undefined` is "not fetched yet", `0` is a fetched, known-zero tally — the two
  // must not look identical, so 0 renders `emptySetLabel` rather than "0".
  if (variant === 'count') {
    if (loading) content = <Spinner />
    else if (count === undefined) content = <span data-testid="chip-empty">–</span>
    else if (count === 0) content = <span data-testid="chip-empty-set">{emptySetLabel}</span>
    else content = <span className="tabular-nums">{count}</span>
  } else {
    content = label
  }

  const Tag = isPressable ? 'button' : 'div'
  const tooltipLabel = disabled
    ? disabledReason
    : label && label.length > 24
      ? label
      : undefined

  return (
    <Tooltip label={tooltipLabel} className={isPressable && disabled ? 'inline-flex' : undefined}>
      <Tag
        type={isPressable ? 'button' : undefined}
        data-testid="chip"
        data-variant={variant}
        aria-disabled={disabled || undefined}
        aria-pressed={isPressable ? selected : undefined}
        disabled={isPressable ? disabled : undefined}
        onClick={isPressable && !disabled ? onClick : undefined}
        className={`inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-pill)] max-w-full px-[var(--space-2)] border text-[length:var(--tr-text-small-size)] font-medium leading-[var(--tr-text-small-leading)] ${shapeRadius} ${TONE_CLASS[tone]} ${
          isPressable ? 'cursor-pointer hover:bg-[var(--surface-hover)] active:scale-[0.96]' : ''
        } ${selected ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--text-primary)]' : ''} ${
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        } focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${className}`}
      >
        {icon && <span aria-hidden className="flex-none">{icon}</span>}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{content}</span>
        {variant === 'removable' && (
          <Tooltip label={disabled ? disabledReason : undefined} className="inline-flex">
            <button
              type="button"
              aria-label={`Remove ${label ?? 'item'}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation()
                onRemove?.()
              }}
              className={`border-0 bg-transparent flex-none inline-flex items-center justify-center h-[16px] w-[16px] rounded-full hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] disabled:opacity-50 disabled:cursor-not-allowed ${HIT_TARGET_28}`}
            >
              <Icon glyph={IconClose} role="label" />
            </button>
          </Tooltip>
        )}
      </Tag>
    </Tooltip>
  )
}
