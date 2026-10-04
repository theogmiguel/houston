import type { ReactNode } from 'react'

export function Caption({ children, className = '', tone = 'secondary' }: { children: ReactNode; className?: string; tone?: 'secondary' | 'faint' }): React.JSX.Element {
  const toneClass = tone === 'faint' ? 'text-[var(--text-faint)]' : 'text-[var(--text-secondary)]'
  return <span className={`text-[length:var(--tr-text-small-size)] ${toneClass} ${className}`}>{children}</span>
}
