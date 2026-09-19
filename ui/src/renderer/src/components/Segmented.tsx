import { useRef } from 'react'
import { HIT_TARGET_28 } from './hitTarget'
import { FOCUS_HALO } from './shadowChrome'
import { Tooltip } from './Tooltip'
import {
  SEG_ITEM_CLS,
  SEG_ITEM_OFF_CLS,
  SEG_ITEM_ON_CLS,
  SEG_TRACK_CLS
} from './segmentedChrome'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: string
  compactLabel?: string
  icon?: React.ReactNode
  disabled?: boolean
  disabledReason?: string
  testId?: string
}

export interface SegmentedProps<T extends string = string> {
  options: SegmentedOption<T>[]
  value?: T
  onChange?: (value: T) => void
  loading?: boolean
  error?: { message: string; onRetry: () => void }
  'aria-label': string
  className?: string
}

function Spinner(): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block h-[12px] w-[12px] animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
    />
  )
}

export function Segmented<T extends string = string>({
  options,
  value,
  onChange,
  loading = false,
  error,
  className = '',
  ...rest
}: SegmentedProps<T>): React.JSX.Element {
  const ariaLabel = rest['aria-label']

  if (error) {
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        data-testid="segmented"
        data-state="error"
        className="inline-flex items-center gap-[var(--space-2)] h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-pill)] border border-[var(--danger)] bg-[var(--status-blocked-bg)] text-[var(--status-blocked-text)] text-[length:var(--tr-text-ui-size)]"
      >
        <span>{error.message}</span>
        <button
          type="button"
          onClick={error.onRetry}
          className={`btn rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current text-[length:var(--tr-text-small-size)] font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
        >
          Try again
        </button>
      </div>
    )
  }

  if (options.length === 0) {
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        data-testid="segmented"
        data-state="empty-set"
        className="inline-flex items-center h-[var(--h-ctl)] px-[var(--space-3)] rounded-[var(--tr-radius-pill)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] text-[length:var(--tr-text-ui-size)]"
      >
        No options
      </div>
    )
  }

  const enabledIndexes = options
    .map((opt, i) => (loading || opt.disabled ? -1 : i))
    .filter((i) => i >= 0)
  const selectedIndex = options.findIndex((opt) => opt.value === value)
  // Roving tabindex: the group is one tab stop, held by the selected option
  // or, with nothing selected yet, the first enabled one.
  const tabbableIndex =
    selectedIndex >= 0 && enabledIndexes.includes(selectedIndex)
      ? selectedIndex
      : (enabledIndexes[0] ?? -1)

  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const moveTo = (index: number): void => {
    const opt = options[index]
    if (!opt) return
    itemRefs.current[index]?.focus()
    onChange?.(opt.value)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (enabledIndexes.length === 0) return
    const focused = itemRefs.current.findIndex((el) => el != null && el === document.activeElement)
    // Step from whatever option actually holds focus, not from `value`:
    // `onChange` is optional, so a caller that ignores it must not leave
    // every arrow press stepping from the same stale index.
    const current = enabledIndexes.includes(focused)
      ? focused
      : enabledIndexes.includes(selectedIndex)
        ? selectedIndex
        : tabbableIndex
    const pos = enabledIndexes.indexOf(current)
    let nextPos: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        nextPos = (pos - 1 + enabledIndexes.length) % enabledIndexes.length
        break
      case 'ArrowRight':
      case 'ArrowDown':
        nextPos = (pos + 1) % enabledIndexes.length
        break
      case 'Home':
        nextPos = 0
        break
      case 'End':
        nextPos = enabledIndexes.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    moveTo(enabledIndexes[nextPos])
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      data-testid="segmented"
      data-state={value === undefined ? 'empty' : 'filled'}
      onKeyDown={handleKeyDown}
      className={`${SEG_TRACK_CLS} ${
        loading ? 'opacity-60' : ''
      } ${className}`}
    >
      {options.map((opt, index) => {
        const selected = opt.value === value
        const disabled = loading || opt.disabled
        return (
          <Tooltip
            key={opt.value}
            label={opt.disabled ? opt.disabledReason : undefined}
            className="inline-flex flex-none"
          >
            <button
              type="button"
              role="radio"
              data-testid={opt.testId}
              aria-checked={selected}
              tabIndex={index === tabbableIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => !disabled && onChange?.(opt.value)}
              ref={(el) => {
                itemRefs.current[index] = el
              }}
              className={`${SEG_ITEM_CLS} ${selected ? SEG_ITEM_ON_CLS : SEG_ITEM_OFF_CLS}`}
            >
              {opt.icon && <span aria-hidden>{opt.icon}</span>}
              {loading && selected ? (
                <Spinner />
              ) : opt.compactLabel !== undefined ? (
                <>
                  <span className="[@container_(max-width:420px)]:hidden">{opt.label}</span>
                  <span className="hidden [@container_(max-width:420px)]:inline">{opt.compactLabel}</span>
                </>
              ) : (
                opt.label
              )}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
