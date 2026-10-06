import type { HTMLAttributes, ReactNode } from 'react'
import { variants } from './variants'

const cardClasses = variants('border', {
  tone: {
    default: 'border-[var(--divider)] bg-[var(--card-bg)]',
    inset: 'border-[var(--divider)] bg-[var(--content-bg)]',
    'material-inset': 'border-[var(--material-inset-brd)] bg-[var(--material-inset-bg)]',
    danger: 'border-[var(--danger)] bg-[var(--status-blocked-bg)]',
    surface: 'border-[var(--border)] bg-[var(--surface)]'
  },
  shape: { button: 'rounded-[var(--tr-radius-button)]', card: 'rounded-[var(--tr-radius-card)]', inset: 'rounded-[var(--tr-radius-sm)]' },
  padding: { none: '', md: 'p-[var(--space-3)]', sm: 'p-[var(--space-2-5)]' },
  disabled: { false: '', true: 'opacity-50' },
  clip: { false: 'overflow-visible', true: 'overflow-hidden' }
}, { tone: 'default', shape: 'button', padding: 'none', disabled: 'false', clip: 'true' })

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  tone?: 'default' | 'inset' | 'material-inset' | 'danger' | 'surface'
  disabled?: boolean
  clip?: boolean
  shape?: 'button' | 'card' | 'inset'
  padding?: 'none' | 'md' | 'sm'
  className?: string
}

export interface CardContentProps {
  children: ReactNode
}

export interface CardGroupProps {
  children: ReactNode
  rail?: 'new' | 'still' | 'gone'
}

export interface CardRowProps {
  heading: ReactNode
  meta?: ReactNode
  status?: ReactNode
  action?: ReactNode
  rail?: 'new' | 'still' | 'gone'
  compact?: boolean
  className?: string
  density?: 'default' | 'compact'
}

const railClasses = variants('relative before:absolute before:inset-y-[var(--space-1)] before:left-0 before:w-[2px]', {
  rail: {
    new: 'before:bg-[var(--warn)]',
    still: 'before:bg-[var(--stop)]',
    gone: 'before:bg-[var(--ok)]'
  }
}, { rail: 'new' })

function CardRow({ heading, meta, status, action, rail, compact = false, className = '', density = 'default' }: CardRowProps): React.JSX.Element {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-[var(--space-2)] ${density === 'compact' ? 'px-[var(--space-2-5)]' : 'px-[var(--space-3)]'} ${compact ? 'py-[var(--space-1)]' : 'py-[var(--space-2)]'} [&+&]:border-t [&+&]:border-[var(--divider)] hover:bg-[var(--hover-fill)] ${rail ? railClasses({ rail }) : ''} ${rail ? 'pl-[var(--space-4)]' : ''} ${className}`}>
      <div className={compact ? 'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[var(--space-2)]' : 'grid min-w-0 flex-1 gap-[var(--space-1)]'}>
        <div className="truncate text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{heading}</div>
        {meta && <div className={`text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)] ${compact ? 'whitespace-nowrap' : ''}`}>{meta}</div>}
      </div>
      {(status || action) && <div className="ml-auto flex flex-none flex-wrap items-center justify-end gap-[var(--space-1-5)]">{status}{action}</div>}
    </div>
  )
}

function CardBase({ children, tone = 'default', shape = 'button', padding = 'none', disabled = false, clip = true, className = '', ...props }: CardProps): React.JSX.Element {
  return <div {...props} className={`${cardClasses({ tone, shape, padding, disabled: disabled ? 'true' : 'false', clip: clip ? 'true' : 'false' })} ${className}`}>{children}</div>
}

function CardContent({ children }: CardContentProps): React.JSX.Element {
  return <div className="grid gap-[var(--space-1)] px-[var(--space-2-5)] pb-[var(--space-2)]">{children}</div>
}

function CardGroup({ children, rail }: CardGroupProps): React.JSX.Element {
  return <section className={`grid gap-[var(--space-1)] ${rail ? railClasses({ rail }) : ''}`}>{children}</section>
}

export const Card = Object.assign(CardBase, { Row: CardRow, Content: CardContent, Group: CardGroup })
