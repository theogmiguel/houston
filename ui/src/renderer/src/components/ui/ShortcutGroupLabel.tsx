import type { ReactNode } from 'react'
import { Text } from './Text'

export function ShortcutGroupLabel({ children, testId }: { children: ReactNode; testId?: string }): React.JSX.Element {
  return <Text as="div" data-testid={testId} className="border-b border-[var(--divider)] bg-[var(--content-bg)] px-[var(--space-3)] py-[var(--space-1-5)]" size="shortcut-label" weight="semibold" tone="muted">{children}</Text>
}

export function ShortcutGroupLabelSpecimen(): React.JSX.Element {
  return <ShortcutGroupLabel>Global</ShortcutGroupLabel>
}
