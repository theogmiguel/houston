import type { HTMLAttributes, ReactNode } from 'react'
import { MATERIAL_CLS, materialAttrs, type Material } from './material'

export interface MaterialSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  material?: Material
  contentEdges?: boolean
  className?: string
  children: ReactNode
}

export function MaterialSurface({ material = 'base', contentEdges = false, className = '', children, ...props }: MaterialSurfaceProps): React.JSX.Element {
  return <div {...props} {...materialAttrs(material)} className={`${className} ${contentEdges ? 'rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)]' : ''} ${MATERIAL_CLS[material]}`}>{children}</div>
}

export function MaterialSurfaceSpecimen(): React.JSX.Element {
  return <div className="overflow-hidden rounded-[var(--tr-radius-md)]"><MaterialSurface contentEdges className="min-h-[var(--h-ctl)] p-[var(--space-3)]">Content edge</MaterialSurface></div>
}
