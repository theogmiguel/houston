// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HoustonClient, ServerMsg } from '../../houston/client'
import { getRailView, setRailView } from '../../railView'
import { TasksSources } from './TasksSources'

afterEach(() => { cleanup(); setRailView(null) })
function fixture() {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const all = new Set<(message: ServerMsg) => void>()
  const emit = (message: ServerMsg) => { handlers.get(message.type)?.forEach((handler) => handler(message)); all.forEach((handler) => handler(message)) }
  const send = vi.fn((message) => {
    if (message.type === 'task_tracker_settings_get') emit({ type: 'task_tracker_settings', settings: [], refusal: null })
    if (message.type === 'workspace_list') emit({ type: 'workspace_list', workspaces: [{ path: '/a', name: 'A' }] })
  })
  const client = {
    subscribe: (type: string, handler: (message: ServerMsg) => void) => {
      const set = handlers.get(type) ?? new Set(); set.add(handler); handlers.set(type, set); return () => set.delete(handler)
    },
    subscribeAll: (handler: (message: ServerMsg) => void) => { all.add(handler); return () => all.delete(handler) },
    send, harnessState: vi.fn(), harnessReport: vi.fn(),
    slackGet: () => emit({ type: 'slack', refusal: null, info: { enabled: true, has_tokens: true, connection: 'connected', channels: [], language: 'en' } })
  } as unknown as HoustonClient
  return { client, emit, send }
}
it('shows real source states, opens the selected form, and restores focus on Escape', () => {
  const { client } = fixture()
  render(<TasksSources client={client} workspace="/a" workspaces={[{ path: '/a', name: 'A' }]} />)
  const trigger = screen.getByRole('button', { name: 'Sources' })
  fireEvent.click(trigger)
  const popover = screen.getByRole('dialog', { name: 'Where tasks come from' })
  expect(within(popover).getByText('Connected')).toBeTruthy()
  expect(within(popover).getAllByText('Off')).toHaveLength(2)
  expect(within(popover).getByText(/owner.*:white_check_mark:/)).toBeTruthy()
  fireEvent.click(screen.getByTestId('task-source-slack'))
  expect(screen.getByRole('dialog', { name: 'Slack' })).toBeTruthy()
  expect(screen.getAllByPlaceholderText('••••••••••••')).toHaveLength(2)
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Slack' }), { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  fireEvent.click(screen.getByTestId('task-source-notion'))
  expect(screen.getByRole('dialog', { name: 'Task sources' })).toBeTruthy()
  expect(screen.getByLabelText('Notion integration token')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Task sources' }), { key: 'Escape' })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByTestId('task-source-github_issues'))
  expect(screen.getByRole('textbox', { name: 'Repository (owner/name)' })).toBeTruthy()
})
it('selects a workspace before tracker setup and sends Review setup to Routines', () => {
  const { client, emit, send } = fixture()
  render(<TasksSources client={client} workspace="" workspaces={[{ path: '/a', name: 'A' }, { path: '/b', name: 'B' }]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sources workspace' }))
  fireEvent.mouseUp(screen.getByRole('option', { name: 'B' }))
  expect(send).toHaveBeenCalledWith({ type: 'task_tracker_settings_get', workspace: '/b' })
  act(() => emit({ type: 'harness_state', workspace: '/b', routine: null, reviews: [], findings: [], models: [], provider_coverage: [], engine_refusals: [] }))
  const row = screen.getByText('Weekly review').closest('[class]')!.parentElement!.parentElement!
  fireEvent.click(within(row).getByRole('button', { name: 'Set up…' }))
  expect(getRailView()).toBe('routines')
})

it('marks connected sources and names the configured Slack channel with an Edit action', () => {
  const { client, emit } = fixture()
  render(<TasksSources client={client} workspace="/a" workspaces={[{ path: '/a', name: 'A' }]} />)
  act(() => emit({ type: 'slack', refusal: null, info: { enabled: true, has_tokens: true, connection: 'connected', channels: [{ channel_id: 'C1234', workspace: '/a' }], language: 'en' } }))
  const trigger = screen.getByRole('button', { name: 'Sources' })
  expect(trigger.querySelector('[aria-label="Connected"]')).not.toBeNull()
  fireEvent.click(trigger)
  expect(screen.getByTestId('task-source-slack').textContent).toBe('Edit')
  expect(screen.getByText(/C1234.*owner.*:white_check_mark:/)).toBeTruthy()
  expect(screen.getByText(/Slack requests wait for/)).toBeTruthy()
})
it('shows an enabled built-in review as On with its Routines action', () => {
  const { client, emit } = fixture()
  render(<TasksSources client={client} workspace="/a" workspaces={[{ path: '/a', name: 'A' }]} />)
  act(() => emit({ type: 'harness_state', workspace: '/a', routine: { kind: 'harness_review', id: 1, name: 'Harness review', prompt: 'Review', cadence: { type: 'clock', hour: 9, minute: 0, weekdays: [2] }, enabled: true, engine: 'claude', next_run_at_ms: 1, permission_mode: 'accept_edits', isolate: false, revision: 'r1' }, reviews: [], findings: [], models: [], provider_coverage: [], engine_refusals: [] }))
  fireEvent.click(screen.getByRole('button', { name: 'Sources' }))
  expect(screen.getByText('Weekly review')).toBeTruthy()
  expect(screen.getByText('On')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Routines' }))
  expect(getRailView()).toBe('routines')
})
