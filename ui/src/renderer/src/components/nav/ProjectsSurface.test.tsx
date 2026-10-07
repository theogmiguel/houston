import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClientMsg, HoustonClient } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskProject } from '../../houston/taskDomain'
import { ProjectsSurface } from './ProjectsSurface'

const WORKSPACE = '/work/app'
const PROJECT: TaskProject = {
  id: 14, workspace: WORKSPACE, name: 'Current project', external_url: null,
  project_external_id: null, tracker_description: null, local_decisions: [], revision: 6, archived_at_ms: null
}

describe('ProjectsSurface', () => {
  it('creates a new project instead of saving over the selected project', () => {
    const listeners = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      taskSnapshot: (scope: string) => emit({ type: 'task_snapshot', scope, tasks: [], counts: { ready: 0, backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 } }),
      send: (message: ClientMsg) => {
        sent.push(message)
        if (message.type === 'task_projects_list') emit({ type: 'task_projects_state', workspace: message.workspace, projects: [PROJECT] })
      }
    } as HoustonClient

    render(<ProjectsSurface client={client} workspace={WORKSPACE} workspaces={[{ path: WORKSPACE, name: 'app' }]} onOpenSession={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Current project' })).toBeTruthy()

    act(() => fireEvent.click(screen.getByRole('button', { name: 'New project' })))
    expect(sent.at(-1)).toMatchObject({
      type: 'task_project_save', workspace: WORKSPACE, id: null, expected_revision: null,
      name: 'New project', external_url: null, tracker_description: null, local_decisions: []
    })
  })
})
