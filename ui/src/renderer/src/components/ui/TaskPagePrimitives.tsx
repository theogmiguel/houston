import type { ReactNode } from 'react'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import { Count } from './Count'
import { TaskProgress } from './TaskProgress'
import { Card } from './Card'

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
        <span className="font-mono text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">{taskKey}</span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">{workspace}</span>
        {actions}
      </div>
      <h1 className="m-0 text-[length:var(--tr-text-heading-size)] font-[var(--tr-text-heading-weight)] tracking-[var(--tr-text-heading-tracking)] leading-[1.2] text-[var(--text-primary)]">{heading}</h1>
      <TaskProgress status={status} />
    </header>
  )
}

export function TaskDetailFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="tasks-root" data-testid="task-detail"><div className="tk-detail" style={{ padding: 'var(--space-2) var(--space-3) var(--space-3)' }}>{children}</div></div>
}

export function TaskDrawerExecutionPanel({ tone, status, metadata, reuse, children }: {
  tone: string
  status: string
  metadata: string
  reuse: string
  children: ReactNode
}): React.JSX.Element {
  return <div className={`exec ${tone === 'needs' ? 'needs' : ''}`} data-presentation="drawer" data-testid="task-execution" style={{ marginTop: 'var(--space-2-5)' }}>
    <div className="h"><span className={`tk-dot ${tone}`} /><b>{status}</b><span data-task-drawer-run-meta>{metadata}</span></div>
    <div data-task-drawer-run-reuse>{reuse}</div>
    {children}
  </div>
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
      className="flex w-full items-center gap-[var(--space-2)] border-0 bg-transparent px-[var(--space-2-5)] py-[var(--space-2)] text-left text-[length:var(--tr-text-small-size)] leading-[var(--tr-text-small-leading)] text-[var(--text-secondary)] hover:enabled:bg-[var(--hover-fill)] disabled:cursor-not-allowed"
      onClick={onToggle}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 flex-none rounded-full ${checked ? 'bg-[var(--ok)]' : 'border border-[var(--text-faint)]'}`} />
      <span className={checked ? 'text-[var(--text-muted)]' : ''}>{text}</span>
      {by && <span className="ml-auto text-[length:var(--tr-text-label-size)] text-[var(--text-faint)]">{by}</span>}
    </button>
  )
}

export function DoneDisclosure({ count, children }: { count: number; children: ReactNode }): React.JSX.Element {
  return (
    <details className="text-[length:var(--tr-text-small-size)] text-[var(--text-muted)]">
      <summary className="cursor-pointer py-[var(--space-1)] hover:text-[var(--text-primary)]">
        Done<Count value={count} /> · Archived
      </summary>
      {children}
    </details>
  )
}

export function TaskQueueMeta({ taskKey, children }: { taskKey: string; children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-[var(--space-1)]">
      <span className="font-mono">{taskKey}</span>
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
