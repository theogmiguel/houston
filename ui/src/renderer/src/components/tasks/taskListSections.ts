import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TaskDomain, TaskProject } from '../../houston/taskDomain'
import { queueGroupOf, queueGroups } from './format'

export type TaskGrouping = 'queue' | 'project'
/** `all`, `none` (tasks without a project) or a project id. */
export type TaskProjectFilter = string

export interface TaskListEntry {
  task: TaskSummary
  section: string
  /** The delivery a slice belongs to, when it is listed. */
  delivery: TaskSummary | null
}

export const NO_PROJECT_SECTION = 'No project'

export function isFinished(task: TaskSummary): boolean {
  const group = queueGroupOf(task)
  return group === 'done' || group === 'archived'
}

export function filterTasks(tasks: readonly TaskSummary[], query: string, filter: TaskProjectFilter, domains: Readonly<Record<number, TaskDomain>>): TaskSummary[] {
  const needle = query.trim().toLowerCase()
  return tasks.filter((task) => {
    if (needle && !task.title.toLowerCase().includes(needle) && !task.key.toLowerCase().includes(needle)) return false
    if (filter === 'all') return true
    const projectId = domains[task.id]?.project_id ?? null
    return filter === 'none' ? projectId == null : String(projectId) === filter
  })
}

export function queueEntries(tasks: readonly TaskSummary[], showFinished: boolean): TaskListEntry[] {
  return queueGroups(tasks)
    .filter((group) => showFinished || group.key !== 'done')
    .flatMap((group) => group.tasks.map((task) => ({ task, section: group.label, delivery: null })))
}

/** Each project's deliveries, each followed by its slices, then the project's other tasks. */
export function projectEntries(tasks: readonly TaskSummary[], projects: readonly TaskProject[], domains: Readonly<Record<number, TaskDomain>>, showFinished: boolean): TaskListEntry[] {
  const visible = tasks.filter((task) => showFinished || !isFinished(task))
  const byId = new Map(visible.map((task) => [task.id, task]))
  const sections = [
    ...projects.filter((project) => project.archived_at_ms == null).map((project) => ({ name: project.name, id: project.id as number | null })),
    { name: NO_PROJECT_SECTION, id: null }
  ]
  return sections.flatMap(({ name, id }) => {
    const members = visible.filter((task) => (domains[task.id]?.project_id ?? null) === id)
    const deliveries = members.filter((task) => domains[task.id]?.kind === 'delivery')
    const listed = new Set<number>()
    const entries: TaskListEntry[] = []
    for (const delivery of deliveries) {
      entries.push({ task: delivery, section: name, delivery: null })
      listed.add(delivery.id)
      for (const slice of members.filter((task) => task.parent_id === delivery.id && !listed.has(task.id))) {
        entries.push({ task: slice, section: name, delivery })
        listed.add(slice.id)
      }
    }
    for (const task of members) {
      if (listed.has(task.id)) continue
      const parent = task.parent_id == null ? null : byId.get(task.parent_id) ?? null
      entries.push({ task, section: name, delivery: parent && domains[parent.id]?.kind === 'delivery' ? parent : null })
    }
    return entries
  })
}
