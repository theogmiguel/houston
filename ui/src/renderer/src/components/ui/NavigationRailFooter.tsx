import type { HTMLAttributes, ReactNode } from 'react'

export function NavigationRailFooter({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`railfoot py-[var(--space-1-5)] px-[var(--space-3)] flex-none flex items-center gap-[var(--space-1)] ${className}`}>{children}</div>
}

export function NavigationRailScroll({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="railscroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">{children}</div>
}

export function WorkspaceList({ children, dragging = false }: { children: ReactNode; dragging?: boolean }): React.JSX.Element {
  return <nav className={`wlist flex flex-col gap-[var(--space-1)] p-[var(--space-2)] overflow-y-auto ${dragging ? 'cursor-grabbing' : ''}`}>{children}</nav>
}

export function SettingsNavigation({ children }: { children: ReactNode }): React.JSX.Element {
  return <nav className="flex flex-col gap-[var(--space-1)] px-[var(--space-2)] pb-[var(--space-2)]" aria-label="Settings sections">{children}</nav>
}
