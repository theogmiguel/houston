import type { ReactNode } from 'react'

export function Caption({ children, className = '', tone = 'secondary', variant = 'default' }: { children: ReactNode; className?: string; tone?: 'secondary' | 'faint'; variant?: 'default' | 'code' }): React.JSX.Element {
  const toneClass = tone === 'faint' ? 'text-[var(--text-faint)]' : 'text-[var(--text-secondary)]'
  const variantClass = variant === 'code' ? 'font-mono tabular-nums' : ''
  return <span className={`text-[length:var(--tr-text-small-size)] ${toneClass} ${variantClass} ${className}`}>{children}</span>
}
