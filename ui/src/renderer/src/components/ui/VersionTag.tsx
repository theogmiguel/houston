import type { ReactNode } from 'react'
import { Text } from './Text'

export function VersionTag({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-[var(--tr-radius-sm)] border border-[var(--border)] px-[var(--space-1-5)] py-[var(--space-version-tag-block)] font-mono text-[var(--text-muted)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)]">
      <Text mono className="contents">{children}</Text>
    </span>
  )
}

export function VersionTagSpecimen(): React.JSX.Element {
  return <div data-testid="version-tag-specimen"><VersionTag>1.0.0 → 1.1.0</VersionTag></div>
}
