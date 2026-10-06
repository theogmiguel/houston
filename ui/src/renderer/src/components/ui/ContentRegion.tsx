import type { ReactNode } from 'react'
import { Text } from './Text'

/** A full-bleed surface that replaces the grid; corner masks come from the content-region hook. */
export function ContentRegion({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="content-region absolute inset-0 flex z-[var(--z-leaf)]">{children}</div>
}

export function ContentRegionSpecimen(): React.JSX.Element {
  return <div data-testid="content-region-specimen" className="relative h-[var(--h-primitives-preview-short)]"><ContentRegion><Text>Full-bleed content</Text></ContentRegion></div>
}
