import type { HTMLAttributes } from 'react'

/** A fixed, non-interactive layer behind the whole window, for the custom background field. */
export function BackdropLayer({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div aria-hidden {...props} className={`fixed inset-0 z-[var(--z-backdrop)] pointer-events-none ${className}`} />
}

export function BackdropLayerSpecimen(): React.JSX.Element {
  return (
    <div data-testid="backdrop-layer-specimen" className="relative h-[var(--h-primitives-preview-short)] overflow-hidden [contain:paint]">
      <BackdropLayer className="bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]" />
    </div>
  )
}
