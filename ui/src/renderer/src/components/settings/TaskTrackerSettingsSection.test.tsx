// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ClientMsg } from '../../houston/client'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskTrackerProvider, TaskTrackerWorkspaceSettings } from '../../houston/taskDomain'
import { TaskTrackerSettingsSection } from './TaskTrackerSettingsSection'

const WORKSPACE = '/work/no-projects'

function settings(provider: TaskTrackerProvider, repository: string | null): TaskTrackerWorkspaceSettings {
  return {
    workspace: WORKSPACE, provider, enabled: false,
    github_repository: repository, github_label: null, github_assigned_user: null,
    notion_data_source_id: null, notion_title_property_id: null, notion_description_property_id: null,
    notion_status_property_id: null, notion_assignee_property_id: null, notion_project_relation_property_id: null,
    notion_assignee_user_id: null, notion_active_status_values: [], notion_projects_data_source_id: null,
    notion_project_title_property_id: null, notion_project_description_property_id: null, notion_pr_url_property_id: null,
    notion_status_mapping: { todo: null, in_progress: null, in_review: null, done: null, canceled: null },
    has_credential: provider === 'notion', last_sync_at_ms: null, last_error: null
  }
}

describe('workspace tracker settings', () => {
  it('edits each provider independently and keeps Notion credentials ephemeral', () => {
    const listeners = new Set<(message: ServerMsg) => void>()
    const sent: ClientMsg[] = []
    const initial: ServerMsg = { type: 'task_tracker_settings', settings: [settings('github_issues', 'acme/app')], refusal: null }
    const emit = (message: ServerMsg): void => listeners.forEach((listener) => listener(message))
    const client = {
      subscribeAll: (listener: (message: ServerMsg) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      send: (message: ClientMsg) => { sent.push(message); if (message.type === 'task_tracker_settings_get') emit(initial) }
    }

    render(<TaskTrackerSettingsSection client={client} workspace={WORKSPACE} workspaceName="No projects yet" />)
    const enabled = screen.getByRole('switch', { name: 'Enable tracker sync' })
    expect(enabled.getAttribute('aria-checked')).toBe('false')
    expect((screen.getByRole('textbox', { name: 'Repository (owner/name)' }) as HTMLInputElement).value).toBe('acme/app')
    expect(screen.queryByRole('textbox', { name: 'Notion integration token' })).toBeNull()

    act(() => fireEvent.click(enabled))
    expect(screen.getByRole('switch', { name: 'Enable tracker sync' }).getAttribute('aria-checked')).toBe('true')

    act(() => emit({ type: 'task_tracker_settings', settings: [settings('notion', null)], refusal: null }))
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Tracker provider' }))
    fireEvent.mouseUp(screen.getByRole('option', { name: 'Notion' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Project title property ID' }), { target: { value: 'project_title_v2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(sent.at(-1)).toMatchObject({ type: 'task_tracker_settings_set', settings: { workspace: WORKSPACE, provider: 'notion', notion_project_title_property_id: 'project_title_v2' } })
    const token = screen.getByLabelText('Notion integration token') as HTMLInputElement
    fireEvent.change(token, { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save token' }))
    expect(sent.at(-1)).toMatchObject({ type: 'task_tracker_credential_set', workspace: WORKSPACE, provider: 'notion', token: 'secret-token' })
    expect(token.value).toBe('')

    const githubSync = {
      type: 'task_tracker_sync_state', workspace: WORKSPACE, provider: 'github_issues', last_sync_at_ms: 1, error: 'GitHub rate limit'
    } satisfies Extract<ServerMsg, { type: 'task_tracker_sync_state' }> & { provider: TaskTrackerProvider }
    const notionSync = {
      type: 'task_tracker_sync_state', workspace: WORKSPACE, provider: 'notion', last_sync_at_ms: 2, error: null
    } satisfies Extract<ServerMsg, { type: 'task_tracker_sync_state' }> & { provider: TaskTrackerProvider }
    act(() => { emit(githubSync); emit(notionSync) })
    expect(screen.getByText(/Last sync/)).toBeTruthy()

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Tracker provider' }))
    fireEvent.mouseUp(screen.getByRole('option', { name: 'GitHub Issues' }))
    expect(screen.getByText('GitHub rate limit')).toBeTruthy()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Tracker provider' }))
    fireEvent.mouseUp(screen.getByRole('option', { name: 'Notion' }))
    expect(screen.queryByText('GitHub rate limit')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Project title property ID' })).toBeTruthy()
  })
})
