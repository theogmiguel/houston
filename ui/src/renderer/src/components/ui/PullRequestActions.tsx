import type { HTMLAttributes, ReactNode } from 'react'

export function PullRequestActionsBar({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`relative flex items-center gap-[var(--space-2)] p-[var(--space-2-5)] border-t border-t-[var(--border)] bg-[var(--material-shell-bg)] ${props.className ?? ''}`}>{children}</div>
}

export function PullRequestActionMenu({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <div {...props} className={`absolute bottom-[calc(100%-var(--space-1))] right-[var(--space-2-5)] z-[var(--z-sticky)] min-w-[220px] flex flex-col gap-[var(--space-1)] p-[var(--space-1)] rounded-[var(--tr-radius-sm)] ${props.className ?? ''}`}>{children}</div>
}

export function PullRequestActionsSpecimen(): React.JSX.Element {
  return <PullRequestActionsBar><span>GitHub</span><span className="flex-1" /><span>Merge</span></PullRequestActionsBar>
}
