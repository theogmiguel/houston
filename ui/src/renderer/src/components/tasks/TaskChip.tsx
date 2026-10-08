import type { SessionTask } from '../../houston/generated/SessionTask'
import { openSideTasks } from '../../sidePanel'
import { TaskKeyChip, TaskKeyTag } from '../ui/TaskKeyChip'
import { Tooltip } from '../ui/Tooltip'
import { runStateLabel } from './format'
import { TaskStatusGlyph } from './glyphs'

// The task a pane is bound to: status glyph and key, title and run state on the tooltip.
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
    <Tooltip label={`Open ${task.key} · Ctrl+click to copy key`}>
      <TaskKeyChip
        data-testid="task-chip"
        aria-label={`Open ${task.key} · Ctrl+click to copy key`}
        onClick={(event) => {
          if (event.ctrlKey) {
            void navigator.clipboard?.writeText(task.key).catch(() => {})
            return
          }
          openSideTasks(false, task.task_id)
        }}
      >
        <TaskStatusGlyph status={task.status} />
        {task.key}
      </TaskKeyChip>
    </Tooltip>
  )
}
