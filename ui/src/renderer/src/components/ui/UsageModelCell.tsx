import type { ReactNode } from 'react'

export function UsageModelCell({
  mark,
  name,
  share,
  color
}: {
  mark: ReactNode
  name: string
  share: number
  color: string
}): React.JSX.Element {
  return (
    <span className="grid w-[220px] min-w-0 max-w-full gap-[var(--space-1)]">
      <span className="flex min-w-0 items-center gap-[var(--space-1-5)] text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">
        <span className="shrink-0" style={{ color }}>{mark}</span>
        <span className="truncate">{name}</span>
      </span>
      <span aria-hidden="true" className="pl-[var(--space-3)]">
        <span className="block h-[2px] w-full rounded-full" style={{ background: `linear-gradient(to right, ${color} ${Math.max(0, Math.min(share, 1)) * 100}%, var(--card-hover) 0)` }} />
      </span>
    </span>
  )
}
