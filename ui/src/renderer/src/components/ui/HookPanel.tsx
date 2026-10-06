import type { HTMLAttributes, ReactNode } from 'react'

export function HookPanel({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): React.JSX.Element {
  return <><div {...props} className="border border-[var(--border)] rounded-[var(--tr-radius-md)] bg-[var(--card-bg)] px-[var(--tr-hook-panel-inset-x)] py-[var(--tr-hook-panel-inset-y)]">{children}</div><div aria-hidden="true" className="h-[var(--tr-hook-panel-following-space)]" /></>
}
