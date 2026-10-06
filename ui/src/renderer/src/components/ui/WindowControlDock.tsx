import type { ReactNode } from 'react'

/** Offsets window buttons from toolbar actions and aligns them with the edge. */
export function WindowControlDock({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center pl-[var(--space-2-5)] -mr-1">{children}</div>
}

export function WindowControlDockSpecimen(): React.JSX.Element {
  return <div data-testid="window-control-dock-specimen" className="flex w-full justify-end"><WindowControlDock><span>Window controls</span></WindowControlDock></div>
}
