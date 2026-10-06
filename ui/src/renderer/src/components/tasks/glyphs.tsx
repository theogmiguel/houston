import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import {
  IconPriorityBars,
  IconPriorityNone,
  IconPriorityUrgent,
  IconTaskStatusBacklog,
  IconTaskStatusCanceled,
  IconTaskStatusDone,
  IconTaskStatusProgress,
  IconTaskStatusReview,
  IconTaskStatusTodo,
  type IconProps
} from '../icons'

export const TASK_GLYPH_CLS = 'flex-none'

export function TaskStatusGlyph({
  status,
  className = TASK_GLYPH_CLS
}: {
  status: TaskStatus
  className?: string
}): React.JSX.Element {
  const Glyph = STATUS_GLYPH[status]
  return <Glyph className={className} />
}

export function TaskPriorityGlyph({
  priority,
  className = TASK_GLYPH_CLS
}: {
  priority: TaskPriority
  className?: string
}): React.JSX.Element {
  if (priority === 'urgent') return <IconPriorityUrgent className={className} />
  if (priority === 'none') return <IconPriorityNone className={className} />
  const level = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1
  return <PriorityBars level={level} className={className} />
}

function PriorityBars({
  level,
  className
}: {
  level: 1 | 2 | 3
  className?: string
}): React.JSX.Element {
  return <IconPriorityBars level={level} className={className} />
}

const STATUS_GLYPH: Readonly<Record<TaskStatus, (p: IconProps) => React.JSX.Element>> = {
  backlog: IconTaskStatusBacklog,
  todo: IconTaskStatusTodo,
  in_progress: IconTaskStatusProgress,
  in_review: IconTaskStatusReview,
  done: IconTaskStatusDone,
  canceled: IconTaskStatusCanceled
}
