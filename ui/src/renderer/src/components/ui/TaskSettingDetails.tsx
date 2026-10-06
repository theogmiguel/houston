import type { ReactNode } from 'react'
import { Text } from './Text'

export function TaskKeyPrefix(): React.JSX.Element {
  return <span className="inline-flex h-[var(--h-ctl)] items-center rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--content-bg)] px-[var(--space-2)] font-mono text-[length:var(--tr-text-ui-size)] text-[var(--text-primary)]">HOU</span>
}

export function TaskSettingDescription({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="block">{children}</span>
}

export function TaskAccessSummary({ children, testId }: { children: ReactNode; testId?: string }): React.JSX.Element {
  return <Text data-testid={testId} className="block pt-[var(--space-task-access-summary)]" size="caption" tone="muted">Currently <strong className="font-semibold text-[var(--text-primary)]">{children}</strong></Text>
}

export function TaskReviewRefusal({ children, testId }: { children: ReactNode; testId?: string }): React.JSX.Element {
  return <Text as="div" data-testid={testId} className="pt-[var(--space-2)]" size="small" tone="danger">{children}</Text>
}

export function TaskInputError({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="max-w-[var(--tr-width-task-error)] text-right"><Text size="small" tone="danger">{children}</Text></div>
}

export function TaskReworkRoundsLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col items-end gap-[var(--space-1)]">{children}</div>
}

export function TaskSettingDetailsSpecimen(): React.JSX.Element {
  return <div className="grid gap-[var(--space-2)]"><TaskKeyPrefix /><TaskSettingDescription>Task descriptions</TaskSettingDescription><TaskAccessSummary>Read and write</TaskAccessSummary><TaskReviewRefusal>Reviewer was unavailable.</TaskReviewRefusal><TaskInputError>Enter a value in range.</TaskInputError><TaskReworkRoundsLayout><Text size="small" tone="muted">Rework rounds</Text></TaskReworkRoundsLayout></div>
}
