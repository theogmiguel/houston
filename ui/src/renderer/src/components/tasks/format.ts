import type { TaskHistoryEntry } from '../../houston/generated/TaskHistoryEntry'
import type { TaskPriority } from '../../houston/generated/TaskPriority'
import type { TaskStatus } from '../../houston/generated/TaskStatus'
import type { TaskSummary } from '../../houston/generated/TaskSummary'

// The Tasks tab order, highest first: active work, then the queue, then the
// settled tail. Mirrors the approved mock's group order; `canceled` closes it
// because slice 1 stores a status the mock predates.
export const STATUS_ORDER: readonly TaskStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'backlog',
  'done',
  'canceled'
]

export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  in_progress: 'In progress',
  in_review: 'In review',
  todo: 'Todo',
  backlog: 'Backlog',
  done: 'Done',
  canceled: 'Canceled'
}

export const STATUS_COLLAPSED_BY_DEFAULT: ReadonlySet<TaskStatus> = new Set(['done', 'canceled'])

export const PRIORITY_LABEL: Readonly<Record<TaskPriority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None'
}

// urgent > high > medium > low > none, then updated desc.
const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4
}

export function compareTasks(a: TaskSummary, b: TaskSummary): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  if (byPriority !== 0) return byPriority
  if (a.updated_at_ms !== b.updated_at_ms) return b.updated_at_ms - a.updated_at_ms
  return b.number - a.number
}

export type TaskGroupKey = TaskStatus | 'archived'

export interface TaskGroup {
  key: TaskGroupKey
  label: string
  tasks: TaskSummary[]
}

const ARCHIVED_LABEL = 'Archived'

/// Non-empty groups only, in display order. Archived tasks leave their status
/// group because restoring them is a different act than working them; slice 1
/// keeps them in the snapshot so the UI can offer that restore.
export function groupTasks(tasks: readonly TaskSummary[]): TaskGroup[] {
  const active = tasks.filter((t) => t.archived_at_ms == null)
  const archived = tasks.filter((t) => t.archived_at_ms != null)
  const groups: TaskGroup[] = []
  for (const status of STATUS_ORDER) {
    const inStatus = active.filter((t) => t.status === status).sort(compareTasks)
    if (inStatus.length > 0) groups.push({ key: status, label: STATUS_LABEL[status], tasks: inStatus })
  }
  if (archived.length > 0) {
    groups.push({ key: 'archived', label: ARCHIVED_LABEL, tasks: [...archived].sort(compareTasks) })
  }
  return groups
}

/// Compact age, the same vocabulary the mock's `.tk-age` uses: now, 8m, 3h, 2d.
export function formatAge(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - atMs) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function formatAgo(atMs: number, nowMs: number): string {
  const age = formatAge(atMs, nowMs)
  return age === 'now' ? 'just now' : `${age} ago`
}

/// `user` is whoever is reading; a provenance string from an agent stands as
/// written so attribution survives.
export function actorLabel(actor: string): string {
  return actor === 'user' ? 'You' : actor
}

/// One line naming what a history update moved, from the stored JSON diff.
export function describeTaskChanges(changes: string): string {
  try {
    const parsed = JSON.parse(changes) as Record<string, unknown>
    const keys = Object.keys(parsed)
    const labels = keys.map((key) => CHANGE_LABEL[key] ?? key)
    if (labels.length === 0) return 'this task'
    if (labels.length === 1) return labels[0]
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  } catch {
    return 'this task'
  }
}

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  parent_id: 'parent',
  ref_url: 'link',
  acceptance: 'acceptance'
}

export interface HistoryLine {
  verb: string
  detail?: string
}

/// The activity verb for one history row. `comment` history is skipped by the
/// caller because the comment row itself carries the same timestamp.
export function historyLine(entry: TaskHistoryEntry): HistoryLine | null {
  switch (entry.action) {
    case 'create':
      return { verb: 'created this task' }
    case 'update':
      return { verb: `updated ${describeTaskChanges(entry.changes)}` }
    case 'comment':
      return null
    case 'check':
      return { verb: 'checked an acceptance item', detail: quoteItem(entry.changes) }
    case 'uncheck':
      return { verb: 'unchecked an acceptance item', detail: quoteItem(entry.changes) }
    case 'archive':
      return { verb: 'archived this task' }
    case 'restore':
      return { verb: 'restored this task' }
    default:
      return { verb: entry.action }
  }
}

function quoteItem(changes: string): string | undefined {
  try {
    const text = (JSON.parse(changes) as { text?: unknown }).text
    return typeof text === 'string' ? `“${text}”` : undefined
  } catch {
    return undefined
  }
}

export function acceptanceText(checked: number, total: number): string {
  return `${checked} / ${total}`
}
