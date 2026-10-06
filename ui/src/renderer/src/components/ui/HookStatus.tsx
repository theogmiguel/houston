import type { ReactNode } from 'react'

export function HookStatus({ wired, children }: { wired: boolean; children: ReactNode }): React.JSX.Element {
  return <span className={`flex items-center gap-[var(--space-1-5)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] ${wired ? 'text-[var(--text-secondary)]' : 'text-[var(--warn)]'}`}><span className="inline-block h-[var(--space-1-5)] w-[var(--space-1-5)] flex-none rounded-full" style={{ background: wired ? 'var(--ok)' : 'var(--warn)' }} />{children}</span>
}

export function HookStatusList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-[var(--space-2-5)] flex flex-wrap gap-[var(--tr-hook-status-gap)]">{children}</div>
}
