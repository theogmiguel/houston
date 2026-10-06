import type { ReactNode } from 'react'

export function UsageProviderRow({
  mark,
  label,
  sessions,
  amount,
  note,
  color
}: {
  mark: ReactNode
  label: string
  sessions: number
  amount: string
  note: string
  color: string
}): React.JSX.Element {
  return (
    <div className="grid min-w-0 gap-[var(--space-1)]" data-testid="usage-provider-row">
      <div className="flex min-w-0 items-baseline gap-[var(--space-1-5)]">
        <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ background: color }} />
        <span className="shrink-0" style={{ color }}>{mark}</span>
        <span className="truncate text-[length:var(--tr-text-md)] text-[var(--text-primary)]">{label}</span>
        <span className="text-[length:var(--tr-text-small-size)] text-[var(--text-faint)]">{sessions} sessions</span>
        <span className="ml-auto shrink-0 tabular-nums text-[length:var(--tr-text-md)] font-medium text-[var(--text-primary)]">{amount}</span>
      </div>
      <div className="pl-[var(--space-3)] text-[length:var(--tr-text-small-size)] text-[var(--text-faint)]">{note}</div>
    </div>
  )
}
