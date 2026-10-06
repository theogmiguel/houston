import type { HTMLAttributes, ReactNode } from 'react'

/** A one-line tinted notice inside a settings row: `warn` for a degraded state, `danger` for a failure. */
export function InlineNotice({ tone, children, ...props }: HTMLAttributes<HTMLDivElement> & { tone: 'warn' | 'danger'; children: ReactNode }): React.JSX.Element {
  const color = tone === 'warn' ? 'var(--warning)' : 'var(--danger)'
  return <div {...props} className={`rounded-[var(--tr-radius-button)] border bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-2)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] leading-[var(--tr-text-small-leading)] ${tone === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--danger)]'}`} style={{ borderColor: color, color }}>{children}</div>
}

export function InlineNoticeSpecimen(): React.JSX.Element {
  return <InlineNotice tone="warn">A setting needs attention.</InlineNotice>
}
