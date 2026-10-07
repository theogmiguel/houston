import React from 'react'
import type { ClientMsg, HoustonClient } from '../src/houston/client'
import type { ServerMsg } from '../src/houston/generated/ServerMsg'
import type { TaskSummary } from '../src/houston/generated/TaskSummary'
import type { TaskDomain, TaskProject, TaskTrackerLink, TaskTrackerWorkspaceSettings } from '../src/houston/taskDomain'
import { ProjectsSurface } from '../src/components/nav/ProjectsSurface'
import { TaskTrackerSettingsSection } from '../src/components/settings/TaskTrackerSettingsSection'

const WORKSPACE = '/home/dev/code/houston'
const NOW = 1_791_240_000_000

function task(id: number, title: string, status: TaskSummary['status'], parent_id: number | null = null): TaskSummary {
  return {
    id, workspace: WORKSPACE, number: id, key: `HOU-${id}`, title, status, priority: 'medium', parent_id,
    ref_url: `https://github.com/theogmiguel/houston/issues/${id}`, revision: 3, created_by: 'user',
    created_at_ms: NOW - 86_400_000, updated_at_ms: NOW - 120_000, archived_at_ms: null,
    acceptance_checked: 1, acceptance_total: 2
  }
}

const TASKS = [
  task(40, 'Stabilize session restoration', 'in_progress'),
  task(41, 'Preserve the focused prompt', 'done', 40),
  task(42, 'Expose recovery decisions', 'todo', 40),
  task(44, 'Record pane memory on demand', 'backlog')
]

const PROJECT: TaskProject = {
  id: 9, workspace: WORKSPACE, name: 'Session reliability', external_url: 'https://github.com/theogmiguel/houston/issues/78',
  project_external_id: 'proj_78', tracker_description: 'Improve continuity after process loss.',
  local_decisions: ['Wake only after an explicit user action.'], revision: 5, archived_at_ms: null
}

const PLAN = {
  revision: 2,
  proposal: {
    description: 'Keep a sleeping session visible and preserve its recovery cues.',
    acceptance: ['Pane remains listed while sleeping', 'Focus never wakes the session'],
    pointers: ['SessionPane.tsx', 'session lifecycle contract'],
    out_of_scope: ['Automatic wake on focus'],
    questions: ['Should wake failure offer a fresh start?']
  },
  answers: [],
  approved_revision: null
}

function domain(id: number, kind: 'delivery' | 'slice', projectId: number | null, plan: typeof PLAN | null = null, conflicted = false): TaskDomain {
  const reasons = id === 42 ? ['Task has one unfinished blocker', 'Task needs a verifiable acceptance item'] : id === 40 ? ['Delivery has one blocked Slice'] : []
  if (kind === 'delivery' && projectId == null) reasons.push('Delivery needs an assigned Project')
  if (plan) reasons.push('Task has one unanswered planning question', 'Planning proposal is not approved for this task revision')
  if (conflicted) reasons.push('Task has one unresolved tracker conflict')
  return {
    task_id: id, kind, project_id: projectId, delivery_id: id === 41 || id === 42 ? 40 : null, slice_total: kind === 'delivery' ? 2 : 0, slice_done: kind === 'delivery' ? 1 : 0, planning_session_id: null,
    blocked_by: id === 42 ? [44] : [], plan,
    readiness: {
      ready: reasons.length === 0, reasons,
      acceptance_total: 2, acceptance_verifiable: id === 42 ? 0 : 1, unresolved_questions: plan ? 1 : 0,
      unresolved_tracker_conflicts: conflicted ? 1 : 0, unfinished_blockers: id === 42 ? [44] : []
    }, unresolved_tracker_conflicts: conflicted ? 1 : 0
  }
}

function trackerSettings(): TaskTrackerWorkspaceSettings {
  return {
    workspace: WORKSPACE, provider: 'notion', enabled: true, github_repository: null, github_label: null,
    github_assigned_user: null, notion_data_source_id: '01234567-89ab-cdef-0123-456789abcdef', notion_title_property_id: 'title_prop',
    notion_description_property_id: 'description_prop', notion_status_property_id: 'status_prop',
    notion_assignee_property_id: 'assignee_prop', notion_project_relation_property_id: 'project_prop',
    notion_assignee_user_id: '11111111-2222-3333-4444-555555555555', notion_active_status_values: ['In progress'],
    notion_projects_data_source_id: 'fedcba98-7654-3210-fedc-ba9876543210', notion_project_title_property_id: 'project_title',
    notion_project_description_property_id: 'project_description', notion_pr_url_property_id: 'pr_url',
    notion_status_mapping: { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done', canceled: 'Canceled' },
    has_credential: true, last_sync_at_ms: NOW - 900_000, last_error: null
  }
}

function link(taskId: number, conflicted: boolean): TaskTrackerLink {
  return {
    task_id: taskId, provider: 'notion', external_id: `NOT-${taskId}`, fetched_at_ms: null, body_hash: null, remote_rev: null, synced_at_ms: null,
    url: `https://www.notion.so/acme/NOT-${taskId}`, source: 'source',
    snapshot: {
      base: { title: 'Expose recovery decisions' }, local: { title: 'Expose recovery decisions in Houston' },
      remote: { title: 'Expose recovery decisions' },
      conflicts: conflicted ? [{ field: 'title', base: 'Expose recovery decisions', local: 'Expose recovery decisions in Houston', remote: 'Expose recovery decisions' }] : [],
      revision: 7, project_external_id: 'external-project-9',
      project: { external_id: 'external-project-9', url: 'https://www.notion.so/acme/project-9', title: 'Sessions', description: 'Imported project details from Notion.', unverified: true }
    }, sync_state: conflicted ? { state: 'diverged' } : { state: 'current' }
  }
}

function projectClient(includePlan: boolean, includeConflict: boolean, empty = false): Pick<HoustonClient, 'subscribeAll' | 'taskSnapshot' | 'taskSave' | 'send'> {
  const handlers = new Set<(message: ServerMsg) => void>()
  const emit = (message: ServerMsg): void => handlers.forEach((handler) => handler(message))
  return {
    subscribeAll: (handler: (message: ServerMsg) => void) => { handlers.add(handler); return () => handlers.delete(handler) },
    taskSnapshot: (scope: string) => emit({ type: 'task_snapshot', scope, tasks: TASKS, counts: { ready: 1, backlog: 1, todo: 1, in_progress: 1, in_review: 0, done: 1, canceled: 0 } }),
    taskSave: () => {},
    send: (message: ClientMsg) => {
      if (message.type === 'task_project_get' && message.id === PROJECT.id) emit({ type: 'task_project_state', project: PROJECT })
      if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: WORKSPACE, projects: empty ? [] : [PROJECT, { ...PROJECT, id: 10, name: 'Archived project', archived_at_ms: NOW - 1000 }] })
      if (message.type === 'task_domain_get' && message.id != null) {
        const row = message.id === 40 ? domain(40, 'delivery', 9) : message.id === 41 ? domain(41, 'slice', 9) : message.id === 42 ? domain(42, 'slice', 9, includePlan ? PLAN : null, includeConflict) : domain(44, 'delivery', null)
        emit({ type: 'task_domain_state', domain: row })
      }
      if (message.type === 'task_tracker_settings_get') emit({ type: 'task_tracker_settings', settings: [trackerSettings()], refusal: null })
      if (message.type === 'task_tracker_links_get' && message.task_id != null) emit({ type: 'task_tracker_links', task_id: message.task_id, links: [link(message.task_id, includeConflict && message.task_id === 42)] })
      if (message.type === 'task_plan_start') emit({ type: 'task_plan_started', id: message.id, session_id: 948, revision: 3 })
    }
  }
}

function ProjectStory({ plan = false, conflict = false, empty = false }: { plan?: boolean; conflict?: boolean; empty?: boolean }): React.JSX.Element {
  const client = React.useMemo(() => projectClient(plan, conflict, empty), [plan, conflict, empty])
  const selectedTaskId = plan || conflict ? 42 : 41
  React.useEffect(() => {
    if (empty) return
    const timer = window.setInterval(() => {
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="project-task-${selectedTaskId}"]`)
      if (button) { window.clearInterval(timer); button.click() }
    }, 100)
    const stop = window.setTimeout(() => window.clearInterval(timer), 1000)
    return () => { window.clearInterval(timer); window.clearTimeout(stop) }
  }, [empty, selectedTaskId])
  return <div className="h-full bg-[var(--content-bg)]"><ProjectsSurface client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'houston' }]} onOpenSession={() => {}} /></div>
}

export function ProjectsPageStory(): React.JSX.Element { return <ProjectStory /> }
export function ProjectsPlanStory(): React.JSX.Element { return <ProjectStory plan /> }
export function ProjectsConflictStory(): React.JSX.Element { return <ProjectStory conflict /> }
export function ProjectsEmptyStory(): React.JSX.Element { return <ProjectStory empty /> }
export function TrackerSettingsStory(): React.JSX.Element {
  const client = React.useMemo(() => projectClient(false, false), [])
  return <div className="h-full overflow-auto p-[var(--space-4)]"><TaskTrackerSettingsSection client={client} workspace={WORKSPACE} workspaceName="houston" /></div>
}
