// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from '../../houston/client'
import { TasksSection } from './TasksSection'

afterEach(cleanup)

function fakeClient() {
  const handlers = new Map<string, (message: unknown) => void>()
  const calls = {
    taskGithubGet: vi.fn(),
    taskGithubSet: vi.fn(),
    tasksAccessGet: vi.fn(),
    taskStartSettingsGet: vi.fn(),
    taskReviewSettingsGet: vi.fn()
  }
  const client = {
    subscribe: (type: string, callback: (message: unknown) => void) => {
      handlers.set(type, callback)
      return () => {}
    },
    ...calls
  } as unknown as HoustonClient
  const deliver = (type: string, message: unknown): void => act(() => handlers.get(type)?.(message))
  return { client, calls, deliver }
}

describe('Settings ▸ Tasks GitHub Issues', () => {
  it('shows the current connector state and sends each change', () => {
    const { client, calls, deliver } = fakeClient()
    render(<TasksSection client={client} workspace="/work" workspaceName="work" />)
    expect(calls.taskGithubGet).toHaveBeenCalledWith('/work')
    deliver('task_github', {
      type: 'task_github',
      workspace: '/work',
      settings: { enabled: true, label: 'houston', open_on_create: false },
      repository: 'o/r',
      last_sync_at_ms: null,
      error: 'gh api user failed: not logged in'
    })
    expect(screen.getByTestId('settings-tasks-github-current').textContent).toBe('Currently On · o/r')
    expect(screen.getByTestId('settings-tasks-github-error').textContent).toContain('not logged in')

    fireEvent.click(screen.getByTestId('settings-tasks-github-open-on-create'))
    expect(calls.taskGithubSet).toHaveBeenLastCalledWith('/work', { enabled: true, label: 'houston', open_on_create: true })
    const label = screen.getByTestId('settings-tasks-github-label')
    fireEvent.change(label, { target: { value: 'ready ' } })
    fireEvent.blur(label)
    expect(calls.taskGithubSet).toHaveBeenLastCalledWith('/work', { enabled: true, label: 'ready', open_on_create: false })

    deliver('task_refused', {
      type: 'task_refused',
      id: null,
      kind: 'limit',
      limit: 50,
      requested: 51,
      message: 'task_github_set refused: 51 chars in the label (limit is 50)'
    })
    expect(screen.getByTestId('settings-tasks-github-refusal').textContent).toContain('limit is 50')
  })
})
