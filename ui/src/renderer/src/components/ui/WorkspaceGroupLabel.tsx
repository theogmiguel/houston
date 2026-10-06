import type { HTMLAttributes, ReactNode } from 'react'

export function WorkspaceGroupLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="px-[var(--space-2)] pt-[var(--space-2)] pb-[var(--space-1)] [font-size:var(--tr-text-label-size)] [font-weight:var(--tr-text-label-weight)] tracking-[0.1em] uppercase text-[var(--text-faint)] select-none">{children}</div>
}

export function WorkspaceGroupLabelSpecimen(): React.JSX.Element {
  return <WorkspaceGroupLabel>Other workspaces</WorkspaceGroupLabel>
}

export function HorizontalRule({ className = '' }: { className?: string }): React.JSX.Element {
  return <div className={`h-px bg-[var(--border)] ${className}`} />
}

export function WorkspaceGroupDivider({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`mx-[var(--space-2)] pt-[var(--space-2)] ${className}`}>{children}</div>
}
