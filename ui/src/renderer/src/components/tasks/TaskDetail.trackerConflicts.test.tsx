// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { Task } from '../../houston/generated/Task'
import type { TaskProject, TaskTrackerLink } from '../../houston/taskDomain'
import { TaskDetail } from './TaskDetail'

const TASK: Task = {
  id: 7, workspace: '/work/app', number: 7, key: 'HOU-7', title: 'Task title', description: '', status: 'todo', priority: 'none',
  parent_id: null, ref_url: null, revision: 12, created_by: 'user', created_at_ms: 1, updated_at_ms: 2, archived_at_ms: null
}

const LINK: TaskTrackerLink = {
  task_id: TASK.id, provider: 'github_issues', external_id: '7', url: 'https://github.com/acme/app/issues/7',
  fetched_at_ms: 1, body_hash: null, remote_rev: null, synced_at_ms: 1, source: 'source',
  snapshot: {
    base: { title: 'Base task', 'project.title': 'Base project' },
    local: { title: 'Local task', 'project.title': 'Local project' },
    remote: { title: 'Remote task', 'project.title': 'Remote project' },
    conflicts: [
      { field: 'title', base: 'Base task', local: 'Local task', remote: 'Remote task' },
      { field: 'project.title', base: 'Base project', local: 'Local project', remote: 'Remote project' }
    ], revision: 19, project_external_id: null, project: null
  }, sync_state: { state: 'diverged' }
}

const PROJECT: TaskProject = {
  id: 9, workspace: TASK.workspace!, name: 'Current project', external_url: null, tracker_description: null,
  project_external_id: null, local_decisions: [], revision: 3, archived_at_ms: null
}

describe('TaskDetail tracker conflict guards', () => {
  afterEach(cleanup)
  it.each(['project.title', 'project.identity'])('guards %s choices with fresh Project state and all revisions', (projectField) => {
    const link = { ...LINK, snapshot: { ...LINK.snapshot, conflicts: [LINK.snapshot.conflicts[0]!, { ...LINK.snapshot.conflicts[1]!, field: projectField }] } }
    const listeners = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: () => {},
      taskSave: () => {},
      send: (message: ClientMsg) => sent.push(message)
    }

    render(<TaskDetail
      detail={{ task: TASK, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null} client={client}
      onBack={() => {}} onReload={() => {}} onSave={() => {}} onCheck={() => {}} onComment={() => {}}
      onArchive={() => {}} onStart={() => {}} onRunControl={() => {}} onOpenSession={() => {}} onReview={() => {}}
    />)

    expect(sent).toContainEqual({ type: 'task_domain_get', id: TASK.id })
    expect(sent).toContainEqual({ type: 'task_tracker_links_get', task_id: TASK.id })
    act(() => emit({ type: 'task_tracker_links', task_id: TASK.id, links: [link] }))
    expect(screen.getByText('Houston value: Local project')).toBeTruthy()

    const choices = screen.getAllByRole('button', { name: 'Use tracker value' })
    expect((choices[0] as HTMLButtonElement).disabled).toBe(false)
    expect((choices[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(choices[0]!)
    expect(sent.at(-1)).toMatchObject({
      type: 'task_tracker_conflict_resolve', task_id: TASK.id, expected_revision: LINK.snapshot.revision,
      expected_task_revision: TASK.revision, expected_project_revision: null, field: 'title', resolution: { kind: 'remote' }
    })

    act(() => emit({ type: 'task_domain_state', domain: {
      task_id: TASK.id, kind: 'delivery', project_id: PROJECT.id, delivery_id: null, blocked_by: [], slice_total: 0, slice_done: 0,
      planning_session_id: null, readiness: { ready: true, reasons: [], acceptance_total: 0, acceptance_verifiable: 0, acceptance_executable: 0, unresolved_questions: 0, unresolved_tracker_conflicts: 0, unfinished_blockers: [] },
      plan: null, unresolved_tracker_conflicts: 0
    } }))
    expect(sent.at(-1)).toEqual({ type: 'task_project_get', id: PROJECT.id })

    act(() => emit({ type: 'task_project_state', project: { ...PROJECT, id: 10, revision: 50 } }))
    expect((screen.getAllByRole('button', { name: 'Use tracker value' })[1] as HTMLButtonElement).disabled).toBe(true)
    act(() => emit({ type: 'task_project_state', project: PROJECT }))
    expect((screen.getAllByRole('button', { name: 'Use tracker value' })[1] as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: 'Use tracker value' })[1]!)
    expect(sent.at(-1)).toMatchObject({
      type: 'task_tracker_conflict_resolve', task_id: TASK.id, expected_revision: LINK.snapshot.revision,
      expected_task_revision: TASK.revision, expected_project_revision: PROJECT.revision, field: projectField, resolution: { kind: 'remote' }
    })

    act(() => emit({ type: 'task_project_changed', workspace: TASK.workspace!, id: PROJECT.id, revision: 4 }))
    expect(sent.at(-1)).toEqual({ type: 'task_project_get', id: PROJECT.id })
    expect((screen.getAllByRole('button', { name: 'Use tracker value' })[1] as HTMLButtonElement).disabled).toBe(true)
    act(() => emit({ type: 'task_project_state', project: PROJECT }))
    expect((screen.getAllByRole('button', { name: 'Use tracker value' })[1] as HTMLButtonElement).disabled).toBe(true)
    act(() => emit({ type: 'task_project_state', project: { ...PROJECT, revision: 4 } }))
    expect((screen.getAllByRole('button', { name: 'Use tracker value' })[1] as HTMLButtonElement).disabled).toBe(false)
  })
})
