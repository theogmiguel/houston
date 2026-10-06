import { IconChevronLeft } from '../icons'
import { Icon } from './Icon'
import { CONTROL_SIZE_SQUARE_CLS } from '../controlSize'
import { HIT_TARGET_28 } from '../hitTarget'
import { PAGE_COLUMN_WIDE_CLS } from './settingsPrimitives'
import { Text } from './Text'

const FEEDBACK_MIN_CLS = 'min-h-[var(--h-feedback-min)]'
const EMPTY_MIN_CLS = 'min-h-[var(--h-empty-pane-min)]'
const BACK_BAR_CLS = 'h-[var(--h-back-bar)]'
const EMPTY_TILE_CLS = 'w-[var(--sz-empty-icon)] h-[var(--sz-empty-icon)]'

export function ContentColumn({
  wide,
  children
}: {
  wide?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="nav-column"
      className={
        wide
          ? `w-full ${PAGE_COLUMN_WIDE_CLS} mx-auto px-[var(--space-content-column-inset)] py-[var(--space-content-column-inset)]`
          : 'w-[var(--w-content-column-constrained)] mx-auto pt-[var(--space-content-column-top)] pb-[var(--space-content-column-bottom)]'
      }
    >
      {children}
    </div>
  )
}

const FEEDBACK_TONE: Record<'neutral' | 'error' | 'warning', string> = {
  error: 'border-[color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color-mix(in_srgb,var(--danger)_11%,transparent)]',
  warning: 'border-[color-mix(in_srgb,var(--warning)_42%,transparent)] bg-[color-mix(in_srgb,var(--warning)_11%,transparent)]',
  neutral: 'border-[var(--border)] bg-[var(--card-bg)]'
}

const FEEDBACK_ICON_TONE: Record<'neutral' | 'error' | 'warning', string> = {
  error: 'text-[var(--danger)]',
  warning: 'text-[var(--warning)]',
  neutral: 'text-[var(--text-secondary)]'
}

export function FeedbackBanner({
  tone = 'neutral',
  icon,
  children,
  onDismiss,
  testId
}: {
  tone?: 'neutral' | 'error' | 'warning'
  icon?: React.ReactNode
  children: React.ReactNode
  onDismiss?: () => void
  testId?: string
}): React.JSX.Element {
  return (
    <div className="pb-[var(--space-feedback-bottom)]">
      <div
        data-testid={testId}
        className={`flex items-center gap-[var(--space-feedback-gap)] ${FEEDBACK_MIN_CLS} px-[var(--space-feedback-inset)] py-[var(--space-feedback-block)] rounded-[var(--tr-radius-sm)] border [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[1.4] text-[var(--text-primary)] ${FEEDBACK_TONE[tone]}`}
      >
        {icon && <span className={`flex-none ${FEEDBACK_ICON_TONE[tone]}`}>{icon}</span>}
        <Text className="flex-1 min-w-0">{children}</Text>
        {onDismiss && (
          <button
            type="button"
            className="btn flex-none border-0 bg-transparent px-[var(--space-dismiss-inset)] py-[var(--space-dismiss-block)] [font-size:var(--tr-text-small-size)] font-semibold text-[var(--text-primary)] cursor-pointer"
            onClick={onDismiss}
          >
            <Text as="span" size="small" weight="semibold" tone="primary">Dismiss</Text>
          </button>
        )}
      </div>
    </div>
  )
}

export function DetailState({
  heading,
  title,
  detail,
  tone = 'neutral',
  action,
  testId
}: {
  heading?: string
  title?: string
  detail: string
  tone?: 'neutral' | 'error'
  action?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  const visibleHeading = heading ?? title ?? ''
  return (
    <div
      data-testid={testId}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-busy={tone === 'neutral' ? true : undefined}
      className="flex flex-col items-center justify-center gap-[var(--space-detail-state-gap)] p-[var(--space-detail-state-inset)] text-center text-[var(--text-faint)]"
    >
      <Text as="strong" size="ui" weight="semibold" tone={tone === 'error' ? 'danger' : 'primary'}>{visibleHeading}</Text>
      <Text size="small" weight="small" leading="normal" className="max-w-[var(--w-detail-state-text)]">{detail}</Text>
      {action && <div className="pt-[var(--space-detail-action-top)]">{action}</div>}
    </div>
  )
}

export function EmptyPane({
  icon,
  title,
  children,
  action,
  testId
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  action?: React.ReactNode
  testId?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId ?? 'nav-empty'}
      className={`flex flex-col items-center justify-center ${EMPTY_MIN_CLS} p-[var(--space-empty-pane-inset)] text-center`}
    >
      <div className="flex pb-[var(--space-empty-icon-bottom)]">
        <span className={`inline-flex items-center justify-center ${EMPTY_TILE_CLS} rounded-[var(--tr-radius-md)] bg-[var(--hover-fill)] text-[var(--text-faint)]`}>
          {icon}
        </span>
      </div>
      <Text as="h1" size="ui" weight="semibold" tight tone="primary" flush>
        {title}
      </Text>
      <Text as="p" size="small" weight="small" leading="normal" tone="secondary" flush className="max-w-[var(--w-empty-pane-text)] pt-[var(--space-empty-pane-title-top)] pb-[var(--space-empty-pane-body-bottom)] text-pretty">
        {children}
      </Text>
      {action}
    </div>
  )
}

export function SupportingNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="pt-[var(--space-footnote-top)]">
      <Text as="p" data-testid="nav-footnote" size="small" weight="small" leading="normal" tone="faint" flush>
        {children}
      </Text>
    </div>
  )
}

export function BackBar({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`flex-none flex items-center gap-[var(--space-back-bar-gap)] ${BACK_BAR_CLS} px-[var(--space-back-bar-inset)] border-b border-[var(--divider)]`}>
      <button
        type="button"
        data-testid="nav-back"
        className="btn inline-flex items-center gap-[var(--space-back-button-gap)] p-0 border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]"
        onClick={onClick}
      >
        <Icon glyph={IconChevronLeft} role="label" />
        <Text size="small" weight="semibold" tone="secondary">{label}</Text>
      </button>
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** A square icon-only action in a row or toolbar; `danger` tints its hover red. */
export function IconAction({
  danger = false,
  className = '',
  children,
  ...rest
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { 'aria-label': string; danger?: boolean }): React.JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      className={`btn inline-flex items-center justify-center flex-none ${CONTROL_SIZE_SQUARE_CLS.mini} ${HIT_TARGET_28} rounded-[var(--tr-radius-sm)] border-0 bg-transparent text-[var(--text-secondary)] cursor-pointer [transition:color_0.1s_ease-out,background-color_0.1s_ease-out] hover:not-disabled:bg-[var(--hover-fill)] hover:not-disabled:text-[var(--text-primary)] disabled:text-[var(--text-faint)] disabled:opacity-55 disabled:cursor-default ${danger ? 'hover:not-disabled:text-[var(--danger)]!' : ''} ${className}`}
    >
      {children}
    </button>
  )
}
