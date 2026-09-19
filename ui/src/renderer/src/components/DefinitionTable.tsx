import { IconTile } from './IconTile'
import { FOCUS_HALO } from './shadowChrome'
import { HIT_TARGET_28 } from './hitTarget'
import { Tooltip } from './Tooltip'

export interface DefinitionRow {
  icon?: React.ReactNode
  label: string
  value: string
  mask?: boolean
  truncateMiddleAt?: number
}

export interface DefinitionTableError {
  message: string
  onRetry: () => void
}

export interface DefinitionTableProps {
  rows?: DefinitionRow[]
  loading?: boolean
  error?: DefinitionTableError
  disabled?: boolean
  disabledReason?: string
  emptySetLabel?: string
  className?: string
}

export function truncateMiddle(value: string, budget: number): string {
  if (value.length <= budget) return value
  if (budget <= 1) return '…'
  const keep = budget - 1
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`
}

const MASK_REDACTION = '****'
const MASK_PREFIX_SCAN = 12

function maskValue(value: string): string {
  const window = value.slice(0, MASK_PREFIX_SCAN)
  const cut = Math.max(window.lastIndexOf('-'), window.lastIndexOf('_'))
  if (cut < 0 || cut + 1 >= value.length) return MASK_REDACTION
  return `${value.slice(0, cut + 1)}${MASK_REDACTION}`
}

function Frame({
  state,
  className,
  children
}: {
  state: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="definition-table"
      data-state={state}
      className={`rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--text-muted)] ${className ?? ''}`}
    >
      {children}
    </div>
  )
}

export function DefinitionTable({
  rows,
  loading = false,
  error,
  disabled = false,
  disabledReason,
  emptySetLabel = 'Nothing here yet',
  className = ''
}: DefinitionTableProps): React.JSX.Element {
  const isEmpty = rows === undefined
  const isEmptySet = !isEmpty && rows.length === 0

  if (error) {
    return (
      <div
        data-testid="definition-table"
        data-state="error"
        className={`flex items-center gap-[var(--space-2)] rounded-[var(--tr-radius-card)] border border-[var(--danger)] bg-[var(--status-blocked-bg)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--tr-text-small-size)] text-[var(--status-blocked-text)] ${className}`}
      >
        <span className="flex-1">{error.message}</span>
        <button
          type="button"
          onClick={error.onRetry}
          className={`bg-transparent rounded-[var(--tr-radius-button)] px-[var(--space-2)] h-[var(--h-ctl-mini)] border border-current font-semibold focus-visible:outline-none focus-visible:shadow-[${FOCUS_HALO}] ${HIT_TARGET_28}`}
        >
          Try again
        </button>
      </div>
    )
  }

  if (disabled) {
    return (
      <Frame state="disabled" className={`opacity-50 ${className}`}>
        {}
        <span aria-disabled="true">{disabledReason ?? 'Unavailable'}</span>
      </Frame>
    )
  }

  if (loading) {
    return (
      <Frame state="loading" className={`animate-pulse ${className}`}>
        <span role="status" aria-label="Loading">
          Loading…
        </span>
      </Frame>
    )
  }

  if (isEmpty) {
    return (
      <Frame state="empty" className={className}>
        –
      </Frame>
    )
  }

  if (isEmptySet) {
    return (
      <Frame state="empty-set" className={className}>
        {emptySetLabel}
      </Frame>
    )
  }

  return (
    <div
      data-testid="definition-table"
      data-state="filled"
      className={`overflow-hidden rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {rows.map((row, i) => {
        const truncated =
          !row.mask && row.truncateMiddleAt !== undefined
            ? truncateMiddle(row.value, row.truncateMiddleAt)
            : row.value
        const displayValue = row.mask ? maskValue(row.value) : truncated
        const wasTruncated = !row.mask && truncated !== row.value

        return (
          <div
            key={row.label}
            data-testid="definition-row"
            data-masked={row.mask || undefined}
            className={`flex items-stretch ${i > 0 ? 'border-t border-[var(--divider)]' : ''}`}
          >
            <div className="flex w-[160px] max-w-[45%] flex-none items-center gap-[var(--space-2)] bg-[var(--panel)] px-[var(--space-3)] py-[var(--space-2)]">
              {row.icon && <IconTile size="sm" tone="muted" icon={row.icon} />}
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)]">
                {row.label}
              </span>
            </div>
            <Tooltip label={wasTruncated ? row.value : undefined}>
              <div
                data-testid="definition-value"
                className="flex min-w-0 flex-1 items-center overflow-hidden text-ellipsis whitespace-nowrap px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--tr-text-small-size)] text-[var(--text-primary)]"
              >
                {displayValue}
              </div>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}
