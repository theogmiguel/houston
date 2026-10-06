import type { HTMLAttributes, ReactNode } from 'react'

/** The main cell of the shell; its named hooks are styled by the shell layout. */
export function GridRegion({ withSide, children, ...rest }: HTMLAttributes<HTMLElement> & { withSide: boolean; children: ReactNode }): React.JSX.Element {
  return <main {...rest} className={`grid-region ${withSide ? 'with-side' : ''} [grid-area:grid] min-w-0 min-h-0 flex flex-col relative overflow-hidden`}>{children}</main>
}

export function GridRegionSpecimen(): React.JSX.Element {
  return <div data-testid="grid-region-specimen" className="relative h-[var(--h-primitives-preview-short)]"><GridRegion withSide><div className="flex-1">Grid content</div></GridRegion></div>
}
