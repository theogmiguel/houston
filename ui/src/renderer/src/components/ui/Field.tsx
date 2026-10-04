import { cloneElement, useId, type ReactElement } from 'react'

export interface FieldProps {
  label: string
  hint?: string
  error?: string
  children: ReactElement
}

export function Field({ label, hint, error, children }: FieldProps): React.JSX.Element {
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
    <div className="grid gap-[var(--space-1-5)]">
      <span id={labelId} className="text-[length:var(--tr-text-small-size)] font-semibold leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)]">{label}</span>
      {nativeControl ? control : <div role="group" aria-labelledby={labelId} aria-describedby={describedBy} aria-invalid={error ? true : undefined}>{control}</div>}
      {message && <p id={messageId} className={`m-0 text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] ${error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>{message}</p>}
    </div>
  )
}
