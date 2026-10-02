import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { formatAge } from './format'
import { TaskPriorityGlyph, TaskStatusGlyph } from './glyphs'

export function TaskRow({
  task,
  selected,
  now,
  onOpen
}: {
  task: TaskSummary
  selected: boolean
  now: number
  onOpen: (id: number) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      data-task={task.number}
      className={`tk-row ${selected ? 'sel' : ''}`}
      onClick={() => onOpen(task.id)}
    >
      <TaskPriorityGlyph priority={task.priority} />
      <TaskStatusGlyph status={task.status} />
      <span className="tk-key">{task.key}</span>
      <span className="tk-title">{task.title}</span>
      <span className="tk-age">{formatAge(task.updated_at_ms, now)}</span>
    </button>
  )
}
