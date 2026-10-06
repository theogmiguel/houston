import type { ReactNode } from 'react'
import { BTN_PRIMARY } from './buttonChrome'
import { Tooltip } from './Tooltip'

const SIZE = {
  full: {
    root: 'gap-[var(--space-4)] px-[var(--space-6)]',
    headline:
      'font-[family-name:var(--tr-text-display-family)] text-[length:var(--tr-text-display-size)] ' +
      'leading-[1.15] tracking-[-0.02em] max-w-[20ch]',
    headlineWeight: 'var(--tr-text-display-weight)',
    description:
      'max-w-[52ch] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] leading-[1.65]',
    action:
      'h-9 mt-[var(--space-2)] px-[var(--space-5)] [font-size:var(--tr-text-ui-size)] ' +
      '[font-weight:var(--tr-text-ui-weight)]'
  },
  compact: {
    root: 'gap-[var(--space-2)] px-[var(--space-4)]',
    headline:
      'text-[length:var(--tr-text-subhead-size)] leading-[1.25] ' +
      '[letter-spacing:var(--tr-text-subhead-tracking)] max-w-[24ch]',
    headlineWeight: 'var(--tr-text-subhead-weight)',
    description:
      'max-w-[36ch] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ' +
      'leading-[var(--tr-text-small-leading)]',
    action:
      'h-[var(--h-ctl)] mt-[var(--space-1)] px-[var(--space-3)] [font-size:var(--tr-text-small-size)] ' +
      '[font-weight:var(--tr-text-small-weight)]'
  }
} as const

export type EmptyStateSize = keyof typeof SIZE

export interface EmptyStateAction {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
}

export interface EmptyStateProps {
  headline: string
  description?: string
  action: EmptyStateAction
  icon?: ReactNode
  loading?: boolean
  size?: EmptyStateSize
  testId?: string
  actionTestId?: string
  actionClassName?: string
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

export function EmptyState({
  headline,
  description,
  action,
  icon,
  loading = false,
  size = 'full',
  testId = 'empty-state',
  actionTestId = 'empty-state-action',
  actionClassName = BTN_PRIMARY,
  className = ''
}: EmptyStateProps): React.JSX.Element {
  const disabled = loading || action.disabled
  const title = action.disabled ? action.disabledReason : undefined
  const step = SIZE[size]

  return (
    <div
      data-testid={testId}
      data-state={loading ? 'loading' : 'filled'}
      data-size={size}
      className={`flex flex-col items-center justify-center text-center ${step.root} ${className}`}
    >
      {icon && (
        <span aria-hidden className="flex-none text-[var(--text-muted)]">
          {icon}
        </span>
      )}
      <div
        data-testid="empty-state-headline"
        className={`text-[var(--text-primary)] ${step.headline}`}
        style={{ fontWeight: step.headlineWeight }}
      >
        {headline}
      </div>
      {description && (
        <p className={`m-0 text-[var(--text-muted)] ${step.description}`}>
          {description}
        </p>
      )}
      <Tooltip label={title} className="inline-flex">
        <button
          type="button"
          data-testid={actionTestId}
          disabled={disabled}
          aria-busy={loading || undefined}
          onClick={action.onClick}
          className={`btn ${actionClassName} border ${step.action} rounded-[var(--tr-radius-button)] inline-flex items-center gap-[var(--space-2)] disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {loading && <Spinner />}
          {action.label}
        </button>
      </Tooltip>
    </div>
  )
}
