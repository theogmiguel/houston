import type { SessionTask } from '../../houston/generated/SessionTask'
import { openSideTasks } from '../../sidePanel'
import { Tooltip } from '../Tooltip'
import { runStateLabel } from './format'
import { TaskStatusGlyph } from './glyphs'

// The task a pane is bound to: status glyph and key, title and run state on the
// tooltip; a click opens the Tasks tab on it. `compact` (roster rows) shows the
// key only and skips the header's container-hide.
export function TaskChip({ task, compact = false }: { task: SessionTask; compact?: boolean }): React.JSX.Element {
  const label = `${task.title}\n${runStateLabel(task.run_state)}`
  if (compact) {
    return (
      <Tooltip label={label} className="inline-flex">
        <span data-testid="task-chip" className="tkchip">
          {task.key}
        </span>
      </Tooltip>
    )
  }
  return (
    <Tooltip label={label}>
      <button
        type="button"
        data-testid="task-chip"
        aria-label={`Task ${task.key}: ${task.title} — ${runStateLabel(task.run_state)}`}
        className="tkchip [@container_(max-width:340px)]:hidden"
        onClick={() => openSideTasks(false, task.task_id)}
      >
        <TaskStatusGlyph status={task.status} />
        {task.key}
      </button>
    </Tooltip>
  )
}
