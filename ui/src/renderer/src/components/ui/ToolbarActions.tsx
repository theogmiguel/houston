import type { ReactNode } from 'react'

/** The right-hand cluster of the top bar. */
export function ToolbarActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="ml-auto flex items-center gap-1 pr-1">{children}</div>
}

export function ToolbarActionsSpecimen(): React.JSX.Element {
  return <div data-testid="toolbar-actions-specimen" className="flex w-full items-center"><span>Workspace</span><ToolbarActions><span>Actions</span></ToolbarActions></div>
}
