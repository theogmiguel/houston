import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { Chip } from '../ui/Chip'
import {
  TaskAge,
  TaskAgentIcon,
  TaskDot,
  TaskKey,
  TaskListRow,
  TaskListTitle,
  TaskLive,
  TaskStateText,
  TaskTagChip
} from '../ui/TaskSurface'
import { Tooltip } from '../ui/Tooltip'
import { formatAge, runStateLabel, runStateTone, taskAgentLabel } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'

// The fixed right slot of a task row: a run's provider, state dot and label,
// or the task's age when no run is open. The provider mark is the pane
// header's own agent glyph, colored by brand.
export function TaskRunMark({ run, showProvider = true }: { run: TaskRun; showProvider?: boolean }): React.JSX.Element {
  const tone = runStateTone(run.state)
  return (
    <TaskLive data-testid="task-run-mark">
      {showProvider && (
        <Tooltip label={taskAgentLabel(run.provider)} className="inline-flex">
          <TaskAgentIcon agent={run.provider} />
        </Tooltip>
      )}
      <TaskDot tone={tone} />
      <TaskStateText tone={tone}>{runStateLabel(run.state, run.kind)}</TaskStateText>
    </TaskLive>
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
    <TaskListRow
      aria-current={selected || undefined}
      data-task={task.number}
      selected={selected}
      withWorkspace={showWorkspace}
      onClick={() => onOpen(task.id)}
    >
      <TaskPriorityGlyph priority={task.priority} />
      <TaskStatusGlyph status={task.status} />
      <TaskKey>{task.key}</TaskKey>
      <TaskListTitle>{task.title}</TaskListTitle>
      {showWorkspace && (
        <Tooltip label={task.workspace ?? 'No workspace'} className="inline-flex min-w-0">
          <TaskTagChip narrow data-testid="task-workspace-chip">
            <span className="truncate">{task.workspace?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'No workspace'}</span>
          </TaskTagChip>
        </Tooltip>
      )}
      {task.children_total > 0 && (
        <Tooltip label={`${task.children_done} of ${task.children_total} subtasks done`} className="inline-flex">
          <span data-testid="task-children-progress">
            <Chip variant="state" tone={task.children_done === task.children_total ? 'success' : 'default'} label={`${task.children_done}/${task.children_total}`} />
          </span>
        </Tooltip>
      )}
      {intakeLabel(task) && (
        <span data-testid="task-intake-chip">
          <Chip variant="state" tone="info" label={intakeLabel(task) ?? undefined} />
        </span>
      )}
      {task.open_run ? (
        <TaskRunMark run={task.open_run} />
      ) : (
        <TaskAge>{formatAge(task.updated_at_ms, now)}</TaskAge>
      )}
    </TaskListRow>
  )
}
