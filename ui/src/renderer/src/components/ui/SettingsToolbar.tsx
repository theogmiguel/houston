import type { ReactNode } from 'react'
export function SettingsToolbar({ children, actions }: { children: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-[var(--space-2)]">{children}{actions && <span className="ml-auto flex items-center gap-[var(--space-2)]">{actions}</span>}</div>
}
