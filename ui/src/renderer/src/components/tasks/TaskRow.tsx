import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { IconAgent } from '../icons'
import { Chip } from '../Chip'
import { Tooltip } from '../Tooltip'
import { formatAge, runStateLabel, runStateTone, taskAgentLabel } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'

// The fixed right slot of a task row: a run's provider, state dot and label,
// or the task's age when no run is open. The provider mark is the pane
// header's own agent glyph, colored by brand.
export function TaskRunMark({ run, showProvider = true }: { run: TaskRun; showProvider?: boolean }): React.JSX.Element {
  const tone = runStateTone(run.state)
  return (
    <span className="tk-live" data-testid="task-run-mark">
      {showProvider && (
        <Tooltip label={taskAgentLabel(run.provider)} className="inline-flex">
          <IconAgent agent={run.provider} brand className="w-3.5 h-3.5 flex-none" />
        </Tooltip>
      )}
      <span className={`tk-dot ${tone}`} />
      <span className={`tk-st ${tone}`}>{runStateLabel(run.state, run.kind)}</span>
    </span>
  )
}

// A Slack-filed task waiting to start says why: for the owner's ✅, or for a
// working slot with its place in the queue.
function intakeLabel(task: TaskSummary): string | null {
  const intake = task.intake
  if (!intake || task.open_run) return null
  if (intake.state === 'pending') return 'Slack · awaiting ✅'
  if (intake.state === 'queued') return `Slack · queued #${intake.queue_position ?? '?'}`
  return null
}

export function TaskRow({
  task,
  selected,
  now,
  showWorkspace = false,
  onOpen
}: {
  task: TaskSummary
  selected: boolean
  now: number
  showWorkspace?: boolean
  onOpen: (id: number) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      data-task={task.number}
      className={`tk-row ${showWorkspace ? 'ws' : ''} ${selected ? 'sel' : ''}`}
      onClick={() => onOpen(task.id)}
    >
      <TaskPriorityGlyph priority={task.priority} />
      <TaskStatusGlyph status={task.status} />
      <span className="tk-key">{task.key}</span>
      <span className="tk-title">{task.title}</span>
      {showWorkspace && <Tooltip label={task.workspace ?? 'No workspace'} className="inline-flex min-w-0"><span className="chip-branch max-w-[140px]" data-testid="task-workspace-chip"><span className="truncate">{task.workspace?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'No workspace'}</span></span></Tooltip>}
      {intakeLabel(task) && (
        <span data-testid="task-intake-chip">
          <Chip variant="state" tone="info" label={intakeLabel(task) ?? undefined} />
        </span>
      )}
      {task.open_run ? (
        <TaskRunMark run={task.open_run} />
      ) : (
        <span className="tk-age">{formatAge(task.updated_at_ms, now)}</span>
      )}
    </button>
  )
}
