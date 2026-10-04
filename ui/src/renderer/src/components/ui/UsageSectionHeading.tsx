import type { ReactNode } from 'react'

export function UsageSectionHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-[var(--space-2)]">
      <h2 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{children}</h2>
      {aside && <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{aside}</span>}
    </div>
  )
}
