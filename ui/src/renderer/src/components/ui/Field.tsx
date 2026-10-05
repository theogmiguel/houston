import { cloneElement, useId, type ReactElement } from 'react'
import type { ReactNode } from 'react'

export function FieldLabel({ children, size = 'default', id }: { children: ReactNode; size?: 'default' | 'compact'; id?: string }): React.JSX.Element {
  return <span id={id} className={size === 'compact' ? 'text-[length:var(--tr-text-label-size)] font-medium leading-[var(--tr-text-small-leading)] [text-transform:var(--tr-text-label-transform)] tracking-[var(--tr-text-label-tracking)] text-[var(--text-faint)]' : 'text-[length:var(--tr-text-small-size)] font-semibold leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)]'}>{children}</span>
}

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  size?: 'default' | 'compact'
  align?: 'start' | 'center'
  children: ReactElement
}

export function Field({ label, hint, error, size = 'default', align, children }: FieldProps): React.JSX.Element {
  const generatedId = useId()
  const childProps = children.props as { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }
  const controlId = childProps.id ?? generatedId
  const labelId = `${controlId}-label`
  const message = error ?? hint
  const messageId = message ? `${controlId}-message` : undefined
  const describedBy = [childProps['aria-describedby'], messageId].filter(Boolean).join(' ') || undefined
  const nativeControl = typeof children.type === 'string'
  const control = cloneElement(children as ReactElement<Record<string, unknown>>, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : childProps['aria-invalid'],
    'aria-labelledby': labelId
  })

  return (
    <div className={`grid ${size === 'compact' ? 'gap-[var(--space-1)]' : 'gap-[var(--space-1-5)]'} ${align === 'start' ? 'text-left' : align === 'center' ? 'text-center' : ''}`}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      {nativeControl ? control : <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={error ? true : undefined}>{control}</div>}
      {message && <p id={messageId} className={`m-0 text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] ${error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>{message}</p>}
    </div>
  )
}
