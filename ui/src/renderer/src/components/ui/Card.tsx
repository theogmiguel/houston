import type { ReactNode } from 'react'
import { variants } from './variants'

const cardClasses = variants('overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--divider)] bg-[var(--card-bg)]', {
  tone: { default: '', inset: 'bg-[var(--content-bg)]' }
}, { tone: 'default' })

export interface CardProps {
  children: ReactNode
  tone?: 'default' | 'inset'
  className?: string
}

export interface CardRowProps {
  heading: ReactNode
  meta?: ReactNode
  status?: ReactNode
  action?: ReactNode
  rail?: 'new' | 'still' | 'gone'
  compact?: boolean
  className?: string
}

const railClasses = variants('relative before:absolute before:inset-y-[var(--space-1)] before:left-0 before:w-[2px]', {
  rail: {
    new: 'before:bg-[var(--warn)]',
    still: 'before:bg-[var(--stop)]',
    gone: 'before:bg-[var(--ok)]'
  }
}, { rail: 'new' })

function CardRow({ heading, meta, status, action, rail, compact = false, className = '' }: CardRowProps): React.JSX.Element {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-[var(--space-2)] px-[var(--space-3)] ${compact ? 'py-[var(--space-1)]' : 'py-[var(--space-2)]'} [&+&]:border-t [&+&]:border-[var(--divider)] hover:bg-[var(--hover-fill)] ${rail ? railClasses({ rail }) : ''} ${rail ? 'pl-[var(--space-4)]' : ''} ${className}`}>
      <div className={compact ? 'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[var(--space-2)]' : 'grid min-w-0 flex-1 gap-[var(--space-1)]'}>
        <div className="truncate text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{heading}</div>
        {meta && <div className={`text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)] ${compact ? 'whitespace-nowrap' : ''}`}>{meta}</div>}
      </div>
      {(status || action) && <div className="ml-auto flex flex-none flex-wrap items-center justify-end gap-[var(--space-1-5)]">{status}{action}</div>}
    </div>
  )
}

function CardBase({ children, tone = 'default', className = '' }: CardProps): React.JSX.Element {
  return <div className={`${cardClasses({ tone })} ${className}`}>{children}</div>
}

export const Card = Object.assign(CardBase, { Row: CardRow })
