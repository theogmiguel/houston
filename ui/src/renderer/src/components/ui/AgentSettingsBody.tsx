import type { HTMLAttributes, ReactNode } from 'react'
import { PageFrame } from './PageFrame'

export function AgentSettingsBody({ embedded = false, children, ...props }: HTMLAttributes<HTMLDivElement> & { embedded?: boolean; children: ReactNode }): React.JSX.Element {
  return embedded ? <div {...props} className="grid min-w-0 content-start gap-[var(--space-3)]">{children}</div> : <PageFrame {...props} width="wide" className="flex-1 min-w-0">{children}</PageFrame>
}
