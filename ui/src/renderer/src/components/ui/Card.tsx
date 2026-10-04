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
  className?: string
}

function CardRow({ heading, meta, status, action, className = '' }: CardRowProps): React.JSX.Element {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-2)] [&+&]:border-t [&+&]:border-[var(--divider)] hover:bg-[var(--hover-fill)] ${className}`}>
      <div className="grid min-w-0 flex-1 gap-[var(--space-1)]">
        <div className="truncate text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{heading}</div>
        {meta && <div className="text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-muted)]">{meta}</div>}
      </div>
      {(status || action) && <div className="ml-auto flex flex-none flex-wrap items-center justify-end gap-[var(--space-1-5)]">{status}{action}</div>}
    </div>
  )
}

function CardBase({ children, tone = 'default', className = '' }: CardProps): React.JSX.Element {
  return <div className={`${cardClasses({ tone })} ${className}`}>{children}</div>
}

export const Card = Object.assign(CardBase, { Row: CardRow })
