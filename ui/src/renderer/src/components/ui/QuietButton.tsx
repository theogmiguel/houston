import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

const VARIANT = {
  text: 'border-0 bg-transparent cursor-pointer rounded-[var(--tr-radius-button)] px-[var(--space-2)] py-[var(--space-quiet-button-block)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] [--quiet-button-ink:var(--text-muted)] hover:[--quiet-button-ink:var(--text-primary)]',
  fill: 'border-0 bg-transparent hover:bg-[var(--card-hover)]',
  dismiss: 'border-0 bg-transparent flex-none rounded-[var(--tr-radius-sm)] p-1 text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]'
} as const

export type QuietButtonVariant = keyof typeof VARIANT

export type QuietButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  variant: QuietButtonVariant
  /** Layout classes only. */
  className?: string
  children?: ReactNode
}

/** A borderless button for tertiary actions that sit inside a message: skip, reload, dismiss. */
export function QuietButton({ variant, className = '', type = 'button', children, ...rest }: QuietButtonProps): React.JSX.Element {
  return <button {...rest} type={type} className={`${VARIANT[variant]} ${className}`}>{variant === 'text' ? <Text size="small" weight="small" tone="quiet-button" className="contents">{children}</Text> : children}</button>
}

export function QuietButtonSpecimen(): React.JSX.Element {
  return (
    <div data-testid="quiet-button-specimen" className="flex items-center gap-[var(--space-3)]">
      <QuietButton variant="text">Not now</QuietButton>
      <QuietButton variant="fill">Reload app</QuietButton>
      <QuietButton variant="dismiss" aria-label="Dismiss">x</QuietButton>
    </div>
  )
}
