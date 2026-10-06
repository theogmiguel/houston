import type { HTMLAttributes, ReactNode } from 'react'

export type StackAxis = 'horizontal' | 'vertical'
export type StackSpace = 'compact' | 'comfortable'
export type InsetSpace = 'preview' | 'compact-top'

export function Stack({
  axis = 'vertical',
  space = 'comfortable',
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { axis?: StackAxis; space?: StackSpace; children: ReactNode }): React.JSX.Element {
  const direction = axis === 'horizontal' ? 'flex-row items-center' : 'flex-col'
  const gap = space === 'compact' ? 'gap-[var(--space-2)]' : 'gap-[var(--space-3)]'
  return <div {...props} className={`flex ${direction} ${gap} ${className}`}>{children}</div>
}

export function StackSpecimen(): React.JSX.Element {
  return <Inset space="preview"><Stack className="max-w-[var(--w-palette-specimen)]"><span>First item</span><span>Second item</span></Stack></Inset>
}

export function Inset({ children, space }: { children: ReactNode; space: InsetSpace }): React.JSX.Element {
  const classes = space === 'preview'
    ? 'px-[var(--space-4)] pt-[var(--space-4)] pb-[var(--space-3)]'
    : 'pt-[var(--space-2)]'
  return <div className={classes}>{children}</div>
}
