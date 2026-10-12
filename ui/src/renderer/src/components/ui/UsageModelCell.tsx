import type { ReactNode } from 'react'
import { Text } from './Text'

export function UsageModelCell({ mark, name }: { mark: ReactNode; name: string; share?: number; color?: string }): React.JSX.Element {
  return <span className="flex min-w-0 items-center gap-[var(--space-2)]">{mark}<Text size="ui" tone="muted" mono className="truncate">{name}</Text></span>
}
