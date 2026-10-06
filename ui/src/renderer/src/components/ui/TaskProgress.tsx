import type { TaskStatus } from '../../houston/generated/TaskStatus'

const STEPS = ['Backlog', 'In progress', 'In review', 'Done'] as const

export function TaskProgress({ status }: { status: TaskStatus }): React.JSX.Element {
  const current = status === 'in_review' ? 2 : status === 'done' ? 3 : status === 'in_progress' ? 1 : 0
  return (
    <ol aria-label="Task progress" className="grid list-none grid-cols-4 gap-0 p-0 text-[length:var(--tr-text-small-size)]">
      {STEPS.map((step, index) => (
        <li key={step} className={`border-t-2 pt-[var(--space-1)] ${index < current ? 'border-[var(--ok)] text-[var(--text-muted)]' : index === current ? 'border-[var(--info)] font-semibold text-[var(--text-primary)]' : 'border-[var(--divider)] text-[var(--text-faint)]'}`}>
          {step}
        </li>
      ))}
    </ol>
  )
}
