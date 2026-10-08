// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskProject, TaskTrackerProvider } from '../../houston/taskDomain'
import { useTaskProjects } from '../../houston/useTaskProjects'
import { TaskProjectsDialog } from './TaskProjectsDialog'

const WORKSPACE = '/work/app'
const PROJECT: TaskProject = {
  id: 14, workspace: WORKSPACE, name: 'Current project', external_url: null,
  project_external_id: null, tracker_description: null, local_decisions: [], revision: 6, archived_at_ms: null
}

function fakeClient(initial: TaskProject[]) {
  let projects = initial
  const listeners = new Set<(message: ServerMsg) => void>()
  const sent: ClientMsg[] = []
  const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
  const client = {
    subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    send: (message: ClientMsg) => {
      sent.push(message)
      if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: message.workspace, projects })
      if (message.type === 'task_project_save' && message.id === null) {
        projects = [...projects, { ...PROJECT, id: 99, name: message.name, revision: 1 }]
        emit({ type: 'task_project_changed', workspace: message.workspace, id: 99, revision: 1 })
      }
    }
  }
  return { client, sent, emit }
}

function Harness({ client }: { client: ReturnType<typeof fakeClient>['client'] }): React.JSX.Element {
  const projects = useTaskProjects(client, [WORKSPACE], [])
  return <TaskProjectsDialog projects={projects} workspaces={[{ path: WORKSPACE, name: 'app' }]} initialWorkspace={WORKSPACE} onClose={() => {}} />
}

describe('TaskProjectsDialog', () => {
  afterEach(cleanup)

  it('offers the shared empty state when the workspace has no projects', () => {
    const { client } = fakeClient([])
    render(<Harness client={client} />)
    expect(screen.getByRole('dialog', { name: 'Projects' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'No projects yet' })).toBeTruthy()
  })

  it('creates a new project instead of saving over the selected project and shows tracker sync', () => {
    const { client, sent, emit } = fakeClient([PROJECT])
    render(<Harness client={client} />)
    expect((screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement).value).toBe('Current project')
    const githubSync = {
      type: 'task_tracker_sync_state', workspace: WORKSPACE, provider: 'github_issues', last_sync_at_ms: 1, error: 'GitHub rate limit'
    } satisfies Extract<ServerMsg, { type: 'task_tracker_sync_state' }> & { provider: TaskTrackerProvider }
    act(() => emit(githubSync))
    expect(screen.getByText('GitHub Issues sync: Error: GitHub rate limit')).toBeTruthy()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'New project' })))
    expect(sent.find((message) => message.type === 'task_project_save')).toMatchObject({
      type: 'task_project_save', workspace: WORKSPACE, id: null, expected_revision: null,
      name: 'New project', external_url: null, tracker_description: null, local_decisions: []
    })
  })

  it('saves edits against the project revision and archives with the same guard', () => {
    const { client, sent } = fakeClient([PROJECT])
    render(<Harness client={client} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name' }), { target: { value: 'Renamed' } })
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Save project' })))
    expect(sent.at(-1)).toMatchObject({ type: 'task_project_save', id: PROJECT.id, expected_revision: PROJECT.revision, name: 'Renamed' })
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Archive project' })))
    expect(sent.at(-1)).toMatchObject({ type: 'task_project_archive', id: PROJECT.id, archived: true, expected_revision: PROJECT.revision })
  })

  it('selects a newly created project with its name ready to type over', () => {
    const { client } = fakeClient([PROJECT])
    render(<Harness client={client} />)
    act(() => fireEvent.click(screen.getByRole('button', { name: 'New project' })))
    const name = screen.getByRole('textbox', { name: 'Project name' }) as HTMLInputElement
    expect(name.value).toBe('New project')
    expect(document.activeElement).toBe(name)
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 'New project'.length])
  })

  it('opens on the New project action, not on a control whose tooltip would pop up', () => {
    const { client } = fakeClient([])
    render(<Harness client={client} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New project' }))
  })
})
