import type { SessionTask } from '../../houston/generated/SessionTask'
import { openSideTasks } from '../../sidePanel'
import { TaskKeyChip, TaskKeyTag } from '../ui/TaskKeyChip'
import { Tooltip } from '../ui/Tooltip'
import { runStateLabel } from './format'
import { TaskStatusGlyph } from './glyphs'

// The task a pane is bound to: status glyph and key, title and run state on the
// tooltip; a click opens the Tasks tab on it. `compact` (roster rows) shows the
// key only.
export function TaskChip({ task, compact = false }: { task: SessionTask; compact?: boolean }): React.JSX.Element {
  const label = `${task.title}\n${runStateLabel(task.run_state)}`
  if (compact) {
    return (
      <Tooltip label={label} className="inline-flex">
        <TaskKeyTag compact data-testid="task-chip">
          {task.key}
        </TaskKeyTag>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={label}>
      <TaskKeyChip
        data-testid="task-chip"
        aria-label={`Task ${task.key}: ${task.title} — ${runStateLabel(task.run_state)}`}
        onClick={() => openSideTasks(false, task.task_id)}
      >
        <TaskStatusGlyph status={task.status} />
        {task.key}
      </TaskKeyChip>
    </Tooltip>
  )
}
