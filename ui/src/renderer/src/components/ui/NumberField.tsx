import { forwardRef, type InputHTMLAttributes } from 'react'
import { Text } from './Text'
import type { ReactNode } from 'react'

export type NumberFieldWidth = 'compact' | 'medium'

export type NumberFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  width: NumberFieldWidth
}

export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(
  function NumberField({ width, className = '', ...props }, ref): React.JSX.Element {
    const widthClass = width === 'compact' ? 'w-[var(--w-settings-number)]' : 'w-[var(--w-settings-number-wide)]'
    return <input {...props} ref={ref} type="number" className={`bg-[var(--content-bg)] border border-[var(--border)] rounded-[var(--tr-radius-sm)] text-[var(--text-primary)] [font-style:inherit] [font-variant:inherit] [font-weight:inherit] [font-stretch:inherit] [line-height:inherit] [font-family:inherit] [font-size:var(--tr-text-small-size)] py-[var(--space-settings-number-y)] px-2 text-right ${widthClass} ${className}`} />
  }
)

export function NumberFieldSpecimen(): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)]"><NumberField width="compact" aria-label="Compact value" value={8} readOnly /><NumberField width="medium" aria-label="Medium value" value={12} readOnly /></div>
}

export function NumberFieldUnit({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="small" weight="small" tone="muted" className="whitespace-nowrap">{children}</Text>
}

export function NumberFieldMessage({ children, testId }: { children: ReactNode; testId?: string }): React.JSX.Element {
  return <Text as="div" size="small" weight="small" tone="danger" data-testid={testId} className="max-w-[var(--w-settings-number-error)] text-right">{children}</Text>
}
