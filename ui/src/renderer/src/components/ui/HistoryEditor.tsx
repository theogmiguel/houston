import type { ReactNode } from 'react'

export function HistoryEditor({ children, className = '' }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <div className={`border-t border-t-[var(--divider)] px-[var(--tr-history-editor-inset-x)] pt-[var(--tr-badge-inset-y)] pb-[var(--space-3)] ${className}`}>{children}</div>
}
