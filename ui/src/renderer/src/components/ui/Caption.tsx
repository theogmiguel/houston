import type { ReactNode } from 'react'

export function Caption({ children, className = '', tone = 'secondary', variant = 'default' }: { children: ReactNode; className?: string; tone?: 'secondary' | 'faint'; variant?: 'default' | 'provisional' | 'code' }): React.JSX.Element {
  const toneClass = tone === 'faint' ? 'text-[var(--text-faint)]' : 'text-[var(--text-secondary)]'
  const variantClass = variant === 'provisional'
    ? 'shrink-0 [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] [letter-spacing:var(--tr-text-label-tracking)] uppercase text-[var(--text-faint)]'
    : `text-[length:var(--tr-text-small-size)] ${toneClass}${variant === 'code' ? ' font-mono tabular-nums' : ''}`
  return <span className={`${variantClass} ${className}`}>{children}</span>
}
