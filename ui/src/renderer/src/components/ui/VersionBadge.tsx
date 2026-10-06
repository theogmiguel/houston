import type { ReactNode } from 'react'

export function VersionBadge({ children, radius = 'small' }: { children: ReactNode; radius?: 'small' | 'button' }): React.JSX.Element {
  return <span className={`text-[var(--text-muted)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] font-mono border border-[color-mix(in_srgb,var(--border)_60%,transparent)] bg-[color-mix(in_srgb,var(--content-bg)_60%,transparent)] px-[var(--space-1-5)] py-[var(--tr-badge-inset-y)] ${radius === 'small' ? 'rounded-[var(--tr-radius-input)]' : 'rounded-[var(--tr-radius-button)]'}`}>{children}</span>
}
