import type { ReactNode } from 'react'

export function Caption({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <span className={`text-[length:var(--tr-text-small-size)] text-[var(--text-secondary)] ${className}`}>{children}</span>
}
