import type { ReactNode } from 'react'

export function UsageSectionHeading({ children, aside, fullWidth = false }: { children: ReactNode; aside?: ReactNode; fullWidth?: boolean }): React.JSX.Element {
  return (
    <div className={`flex min-w-0 items-baseline gap-[var(--space-2)] ${fullWidth ? 'w-full' : ''}`}>
      <h2 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{children}</h2>
      {aside && <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{aside}</span>}
    </div>
  )
}
