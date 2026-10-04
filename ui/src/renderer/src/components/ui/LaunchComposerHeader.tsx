import type { ReactNode } from 'react'

export function LaunchComposerHeader({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] border-b border-[var(--border)] px-[14px]">{children}</div>
}
