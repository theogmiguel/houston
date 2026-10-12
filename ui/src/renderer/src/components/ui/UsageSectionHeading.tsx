import type { ReactNode } from 'react'

export function UsageSectionHeading({ children, aside, fullWidth = false, inset = false }: { children: ReactNode; aside?: ReactNode; fullWidth?: boolean; inset?: boolean }): React.JSX.Element {
  return (
    <div className={`flex min-w-0 items-baseline gap-[var(--space-2)] ${fullWidth ? 'w-full' : ''} ${inset ? 'px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-1)]' : ''}`}>
      <h2 className="m-0 text-[length:var(--tr-text-ui-size)] font-semibold text-[var(--text-primary)]">{children}</h2>
      {aside && <span className="ml-auto text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{aside}</span>}
    </div>
  )
}
