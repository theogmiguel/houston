import { describe, expect, it } from 'vitest'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import type { TaskDomain, TaskProject } from '../../houston/taskDomain'
import { filterTasks, NO_PROJECT_SECTION, projectEntries, queueEntries } from './taskListSections'

const WORKSPACE = '/work/app'

function task(id: number, title: string, status: TaskSummary['status'], parent_id: number | null = null): TaskSummary {
  return {
    id, workspace: WORKSPACE, number: id, key: `HOU-${id}`, title, status, priority: 'medium', parent_id,
    ref_url: null, revision: 1, created_by: 'user', created_at_ms: id, updated_at_ms: id,
    archived_at_ms: null, acceptance_checked: 0, acceptance_total: 0
  }
}

function project(id: number, name: string, archived = false): TaskProject {
  return { id, workspace: WORKSPACE, name, external_url: null, project_external_id: null, tracker_description: null, local_decisions: [], revision: 1, archived_at_ms: archived ? 1 : null }
}

function domain(task_id: number, kind: TaskDomain['kind'], project_id: number | null): TaskDomain {
  return {
    task_id, kind, project_id, delivery_id: null, blocked_by: [], slice_total: 0, slice_done: 0, planning_session_id: null, plan: null,
    readiness: { ready: true, reasons: [], acceptance_total: 0, acceptance_verifiable: 0, acceptance_executable: 0, unresolved_questions: 0, unresolved_tracker_conflicts: 0, unfinished_blockers: [] },
    unresolved_tracker_conflicts: 0
  }
}

const TASKS = [
  task(1, 'Loose work', 'todo'),
  task(2, 'Slice B', 'todo', 4),
  task(3, 'Unplanned', 'backlog'),
  task(4, 'Delivery', 'in_progress'),
  task(5, 'Slice A', 'done', 4)
]
const DOMAINS: Record<number, TaskDomain> = {
  1: domain(1, 'slice', 9),
  2: domain(2, 'slice', 9),
  4: domain(4, 'delivery', 9),
  5: domain(5, 'slice', 9)
}
const PROJECTS = [project(9, 'Reliability'), project(10, 'Retired', true)]

describe('task list sections', () => {
  it('lists each delivery before its slices, then the project’s other tasks, then tasks without a project', () => {
    const entries = projectEntries(TASKS, PROJECTS, DOMAINS, false)
    expect(entries.map((entry) => [entry.section, entry.task.title, entry.delivery?.key ?? null])).toEqual([
      ['Reliability', 'Delivery', null],
      ['Reliability', 'Slice B', 'HOU-4'],
      ['Reliability', 'Loose work', null],
      [NO_PROJECT_SECTION, 'Unplanned', null]
    ])
  })

  it('shows finished slices only when finished tasks are shown', () => {
    expect(projectEntries(TASKS, PROJECTS, DOMAINS, true).map((entry) => entry.task.title)).toContain('Slice A')
    expect(queueEntries(TASKS, false).map((entry) => entry.task.title)).not.toContain('Slice A')
    expect(queueEntries(TASKS, true).at(-1)?.section).toBe('Done and Archived')
  })

  it('filters by title or key and by project', () => {
    expect(filterTasks(TASKS, 'hou-3', 'all', DOMAINS).map((item) => item.id)).toEqual([3])
    expect(filterTasks(TASKS, 'slice', '9', DOMAINS).map((item) => item.id)).toEqual([2, 5])
    expect(filterTasks(TASKS, '', 'none', DOMAINS).map((item) => item.id)).toEqual([3])
  })
})
