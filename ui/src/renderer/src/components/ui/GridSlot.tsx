import type { HTMLAttributes, ReactNode } from 'react'

/** Wraps the terminal grid without a box; concealed grids remain mounted but invisible. */
export function GridSlot({ concealed, children, ...rest }: HTMLAttributes<HTMLDivElement> & { concealed: boolean; inert?: boolean; children: ReactNode }): React.JSX.Element {
  return <div {...rest} className={`grid-slot contents ${concealed ? 'grid-hidden invisible' : ''}`}>{children}</div>
}

export function GridSlotSpecimen(): React.JSX.Element {
  return <div data-testid="grid-slot-specimen" className="flex h-[var(--h-primitives-preview-short)]"><GridSlot concealed={false}><span>Terminal grid</span></GridSlot></div>
}
