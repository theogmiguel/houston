import type { HTMLAttributes, ReactNode } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'

/** A screen that fills the content region in place of the grid: base material, centred, cut at the region's left corners. */
export function ScreenRegion({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} {...materialAttrs('base')} className={`flex-1 min-w-0 h-full overflow-y-auto flex flex-col items-center justify-center p-[var(--space-7)] rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base} ${className}`}>{children}</div>
}
