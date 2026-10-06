import type { HTMLAttributes, ReactNode } from 'react'
import { MATERIAL_CLS, materialAttrs } from './material'

export interface NavSurfaceFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  children: ReactNode
}

/** The scrolling base-material surface a navigation page sits on, rounded against the rail. */
export function NavSurfaceFrame({ children, ...props }: NavSurfaceFrameProps): React.JSX.Element {
  return (
    <div
      data-testid="nav-surface"
      {...props}
      {...materialAttrs('base')}
      className={`flex-1 min-w-0 h-full min-h-0 overflow-y-auto rounded-tl-[var(--r-content)] rounded-bl-[var(--r-content)] ${MATERIAL_CLS.base}`}
    >
      {children}
    </div>
  )
}

/** A titled group below a page's main content, spaced 24px from it. */
export function NavSurfaceSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <section>{children}</section>
}

/** The grouped settings section below a navigation page's main content. */
export function NavSurfaceContent({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid gap-[var(--space-2-5)] pt-[var(--space-5)]">{children}</div>
}
