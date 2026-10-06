import type { ReactNode } from 'react'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import { Count } from './Count'
import { TaskProgress } from './TaskProgress'
import { Card } from './Card'
import { TaskExecCard, TaskExecHeader, TaskExecMeta, TaskExecReuse, TaskExecTitle } from './TaskRunSurface'
import { TaskDot, TaskPanel, TaskRecordBody } from './TaskSurface'
import { Text } from './Text'

export function TaskDrawerHeader({ taskKey, workspace, heading, status, actions }: {
  taskKey: string
  workspace: string
  heading: string
  status: TaskStatus
  actions: ReactNode
}): React.JSX.Element {
  return (
    <header className="grid gap-[var(--space-3)] pb-[var(--space-3)]">
      <div className="flex min-w-0 items-center gap-[var(--space-2)]">
        <Text mono size="label" tone="faint">{taskKey}</Text>
        <Text size="small" tone="muted" className="min-w-0 flex-1 truncate">{workspace}</Text>
        {actions}
      </div>
      <Text as="h1" size="heading" weight="heading" leading="heading" tone="primary" flush className="tracking-[var(--tr-text-heading-tracking)]">{heading}</Text>
      <TaskProgress status={status} />
    </header>
  )
}

export function TaskDetailFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <TaskPanel data-testid="task-detail">
      <TaskRecordBody drawer>{children}</TaskRecordBody>
    </TaskPanel>
  )
}

export function TaskDrawerExecutionPanel({ tone, status, metadata, reuse, children }: {
  tone: string
  status: string
  metadata: string
  reuse: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <TaskExecCard drawer needs={tone === 'needs'} data-testid="task-execution">
      <TaskExecHeader drawer>
        <TaskDot tone={tone as Parameters<typeof TaskDot>[0]['tone']} />
        <TaskExecTitle>{status}</TaskExecTitle>
        <TaskExecMeta data-task-drawer-run-meta>{metadata}</TaskExecMeta>
      </TaskExecHeader>
      <TaskExecReuse data-task-drawer-run-reuse>{reuse}</TaskExecReuse>
      {children}
    </TaskExecCard>
  )
}

export function TaskAcceptanceRow({ checked, text, by, disabled, testId, onToggle }: {
  checked: boolean
  text: string
  by?: string | null
  disabled?: boolean
  testId?: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      className="flex w-full items-center gap-[var(--space-2)] border-0 bg-transparent px-[var(--space-2-5)] py-[var(--space-2)] text-left hover:enabled:bg-[var(--hover-fill)] disabled:cursor-not-allowed"
      onClick={onToggle}
    >
      <span aria-hidden="true" className={`size-[var(--task-check-indicator-size)] flex-none rounded-[var(--tr-radius-pill)] ${checked ? 'bg-[var(--ok)]' : 'border border-[var(--text-faint)]'}`} />
      <Text as="span" size="small" tone={checked ? 'muted' : 'secondary'} leading="small">{text}</Text>
      {by && <Text as="span" size="label" tone="faint" className="ml-auto">{by}</Text>}
    </button>
  )
}

export function DoneDisclosure({ count, children }: { count: number; children: ReactNode }): React.JSX.Element {
  return (
    <Text as="details" size="small" tone="muted">
      <summary className="cursor-pointer py-[var(--space-1)] hover:text-[var(--text-primary)]">
        Done<Count value={count} /> · Archived
      </summary>
      {children}
    </Text>
  )
}

export function TaskQueueMeta({ taskKey, children }: { taskKey: string; children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[var(--space-1)]">
      <Text mono>{taskKey}</Text>
      <span aria-hidden="true">·</span>
      {children}
    </span>
  )
}

export function TaskDrawerCard({ children }: { children: ReactNode }): React.JSX.Element {
  return <Card>{children}</Card>
}

export function TaskDrawerOrigin({ children }: { children: ReactNode }): React.JSX.Element {
  return <div>{children}</div>
}
