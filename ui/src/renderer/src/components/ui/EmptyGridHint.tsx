import type { ReactNode } from 'react'
import { Text } from './Text'

/** A centered hint for an empty grid. */
export function EmptyGridHint({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" tone="faint" className="flex-1 flex items-center justify-center gap-[var(--space-form-fields)]">{children}</Text>
}

export function EmptyGridHintSpecimen(): React.JSX.Element {
  return <div data-testid="empty-grid-hint-specimen" className="flex h-[var(--h-primitives-preview-short)]"><EmptyGridHint>No terminals here. Press <Text as="b" tone="muted">t</Text> to open one.</EmptyGridHint></div>
}
