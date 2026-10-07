// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskDomain, TaskProject, TaskTrackerLink, TaskTrackerProvider } from '../../houston/taskDomain'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { ProjectsSurface } from './ProjectsSurface'

const WORKSPACE = '/work/app'
const PROJECT: TaskProject = {
  id: 14, workspace: WORKSPACE, name: 'Current project', external_url: null,
  project_external_id: null, tracker_description: null, local_decisions: [], revision: 6, archived_at_ms: null
}

describe('ProjectsSurface', () => {
  afterEach(cleanup)
  it('uses the navigation page frame and shared empty states', () => {
    const listeners = new Set<(message: ServerMsg) => void>()
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: (scope: string) => emit({ type: 'task_snapshot', scope, tasks: [], counts: { ready: 0, backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 } }),
      taskSave: () => {},
      send: (message: ClientMsg) => {
        if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: message.workspace, projects: [] })
      }
    }

    render(<ProjectsSurface client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'app' }]} onOpenSession={() => {}} />)

    expect(screen.getByTestId('nav-surface')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy()
    expect(screen.getByTestId('projects-workspace')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New project' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Select a project' })).toBeTruthy()
  })

  it('creates a new project instead of saving over the selected project', () => {
    const listeners = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: (scope: string) => emit({ type: 'task_snapshot', scope, tasks: [], counts: { ready: 0, backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 } }),
      taskSave: () => {},
      send: (message: ClientMsg) => {
        sent.push(message)
        if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: message.workspace, projects: [PROJECT] })
      }
    }

    render(<ProjectsSurface client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'app' }]} onOpenSession={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Current project' })).toBeTruthy()
    const githubSync = {
      type: 'task_tracker_sync_state', workspace: WORKSPACE, provider: 'github_issues', last_sync_at_ms: 1, error: 'GitHub rate limit'
    } satisfies Extract<ServerMsg, { type: 'task_tracker_sync_state' }> & { provider: TaskTrackerProvider }
    const notionSync = {
      type: 'task_tracker_sync_state', workspace: WORKSPACE, provider: 'notion', last_sync_at_ms: 2, error: null
    } satisfies Extract<ServerMsg, { type: 'task_tracker_sync_state' }> & { provider: TaskTrackerProvider }
    act(() => { emit(githubSync); emit(notionSync) })
    expect(screen.getByText('GitHub Issues sync: Error: GitHub rate limit')).toBeTruthy()
    expect(screen.getByText(/Notion sync: Last sync/)).toBeTruthy()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'New project' })))
    expect(sent.at(-1)).toMatchObject({
      type: 'task_project_save', workspace: WORKSPACE, id: null, expected_revision: null,
      name: 'New project', external_url: null, tracker_description: null, local_decisions: []
    })
  })

  it('sends tracker snapshot, task, and assigned Project revisions when resolving a project conflict', () => {
    const listeners = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const task: TaskSummary = {
      id: 22, workspace: WORKSPACE, number: 22, key: 'HOU-22', title: 'Delivery', status: 'todo', priority: 'medium',
      parent_id: null, ref_url: null, revision: 11, created_by: 'user', created_at_ms: 1, updated_at_ms: 2,
      archived_at_ms: null, acceptance_checked: 0, acceptance_total: 0
    }
    const domain: TaskDomain = {
      task_id: task.id, kind: 'delivery', project_id: PROJECT.id, delivery_id: null, blocked_by: [], slice_total: 0, slice_done: 0,
      planning_session_id: null, readiness: { ready: true, reasons: [], acceptance_total: 0, acceptance_verifiable: 0, unresolved_questions: 0, unresolved_tracker_conflicts: 0, unfinished_blockers: [] },
      plan: null, unresolved_tracker_conflicts: 1
    }
    const link: TaskTrackerLink = {
      task_id: task.id, provider: 'github_issues', external_id: '22', url: 'https://github.com/acme/app/issues/22',
      fetched_at_ms: 1, body_hash: null, remote_rev: null, synced_at_ms: 1, source: 'source',
      snapshot: {
        base: { 'project.title': 'Old project' }, local: { 'project.title': 'Current project' }, remote: { 'project.title': 'Tracker project' },
        conflicts: [{ field: 'project.title', base: 'Old project', local: 'Current project', remote: 'Tracker project' }],
        revision: 19, project_external_id: null, project: null
      }, sync_state: { state: 'diverged' }
    }
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: (scope: string) => emit({ type: 'task_snapshot', scope, tasks: [task], counts: { ready: 1, backlog: 0, todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0 } }),
      taskSave: () => {},
      send: (message: ClientMsg) => {
        sent.push(message)
        if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: message.workspace, projects: [PROJECT] })
        if (message.type === 'task_domain_get') emit({ type: 'task_domain_state', domain })
        if (message.type === 'task_tracker_links_get') emit({ type: 'task_tracker_links', task_id: message.task_id, links: [link] })
      }
    }

    render(<ProjectsSurface client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'app' }]} onOpenSession={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delivery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use tracker value' }))

    expect(sent.at(-1)).toMatchObject({
      type: 'task_tracker_conflict_resolve', task_id: task.id, expected_task_revision: task.revision,
      expected_project_revision: PROJECT.revision, expected_revision: link.snapshot.revision,
      field: 'project.title', resolution: { kind: 'remote' }
    })
  })
})
