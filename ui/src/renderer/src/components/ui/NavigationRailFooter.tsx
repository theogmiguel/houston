import { Text } from './Text'
import type { HTMLAttributes, ReactNode } from 'react'

export function NavigationRailFooter({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`railfoot flex-none flex items-center gap-[var(--space-1)] px-[var(--space-2)] pt-[var(--space-1)] pb-[var(--space-1-5)] ${className}`}>{children}</div>
}

export function NavigationRailScroll({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="railscroll ![scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col">{children}</div>
}

export function WorkspaceList({ children, dragging = false }: { children: ReactNode; dragging?: boolean }): React.JSX.Element {
  return <nav className={`wlist ![scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex flex-col gap-[var(--space-1)] p-[var(--space-2)] overflow-y-auto ${dragging ? 'cursor-grabbing' : ''}`}>{children}</nav>
}

export function SettingsNavigation({ children }: { children: ReactNode }): React.JSX.Element {
  return <nav className="flex flex-col gap-[var(--space-1)] px-[var(--space-2)] pb-[var(--space-2)]" aria-label="Settings sections">{children}</nav>
}

export function SettingsNavigationGroup({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return <section className="grid gap-[var(--space-0-5)] pb-[var(--space-1-5)]"><Text as="h3" size="caption" weight="small" tone="faint" flush className="px-[var(--space-2)] pb-[var(--space-0-5)]">{label}</Text>{children}</section>
}
