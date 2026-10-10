// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMsg, HoustonClient, SessionInfo } from '../../houston/client'
import type { PullRequestLink } from '../../houston/generated/PullRequestLink'
import type { ServerMsg } from '../../houston/generated/ServerMsg'
import type { TaskRun } from '../../houston/generated/TaskRun'
import type { TaskSummary } from '../../houston/generated/TaskSummary'
import { FactorySurface, type FactorySurfaceProps } from './FactorySurface'

const mocks = vi.hoisted(() => ({ useTasks: vi.fn(), startTask: vi.fn() }))
vi.mock('../../houston/useTasks', () => ({ useTasks: mocks.useTasks }))
const settingsNav = vi.hoisted(() => ({ openSettings: vi.fn() }))
vi.mock('../../settingsNav', () => settingsNav)

const NOW = 10 * 60_000

function summary(overrides: Partial<TaskSummary> & { id: number }): TaskSummary {
  return {
    workspace: '/work/app', number: overrides.id, key: `HOU-${overrides.id}`, title: `Task ${overrides.id}`, status: 'todo', priority: 'none',
    parent_id: null, ref_url: null, revision: 1, created_by: 'user', created_at_ms: 1, updated_at_ms: 1, archived_at_ms: null,
    acceptance_checked: 0, acceptance_total: 0, intake: null, open_run: null, open_question: null, origin: null, pr_number: null, pr_url: null,
    ...overrides
  }
}

function run(overrides: Partial<TaskRun> & { id: number; task_id: number }): TaskRun {
  return {
    attempt: 1, kind: 'implementation', state: 'running', provider: 'claude', session_id: null, branch: null, initial_revision: 1,
    started_at_ms: 1, pr_url: null, pr_number: null, pushed_sha: null, evidence: null,
    ...overrides
  }
}

const QUESTION = { id: 31, task_id: 1, run_id: 1, session_id: 41, question: 'Which migration path?', options: ['Add a column', 'Create a table'], recommended: 1, why: null, context: null, created_at_ms: 3 * 60_000 }

const TASKS: TaskSummary[] = [
  summary({ id: 1, title: 'Asks a question', status: 'in_progress', open_run: run({ id: 1, task_id: 1, session_id: 41 }), open_question: QUESTION }),
  summary({ id: 2, title: 'Waits for input', status: 'in_progress', updated_at_ms: 2 * 60_000, open_run: run({ id: 2, task_id: 2, state: 'waiting_for_input', provider: 'codex', session_id: 42 }) }),
  summary({ id: 3, title: 'In review', status: 'in_review', updated_at_ms: 4 * 60_000, pr_number: 57, pr_url: 'https://github.com/acme/app/pull/57' }),
  summary({ id: 4, title: 'Runs now', status: 'in_progress', open_run: run({ id: 4, task_id: 4, session_id: 44, branch: 'houston/task/hou-4', started_at_ms: 5 * 60_000 }) }),
  summary({ id: 5, title: 'Slack pending', intake: { source: 'slack', author: 'U1', state: 'pending', queue_position: null, permalink: null } }),
  summary({ id: 6, title: 'Slack queued', intake: { source: 'slack', author: 'U1', state: 'queued', queue_position: 2, permalink: null } }),
  summary({ id: 7, title: 'Ready one' }),
  summary({ id: 8, title: 'Ready two', workspace: '/work/other' }),
  summary({ id: 9, title: 'Merged', status: 'done', updated_at_ms: NOW - 60_000, pr_number: 58, pr_url: 'https://github.com/acme/app/pull/58' })
]

const SESSIONS = new Map<number, SessionInfo>([[44, {
  id: 44, agent: 'claude', state: 'running', status: 'working', title: 'HOU-4', codename: 'worker', project_dir: '/work/app', cwd: '/work/app',
  hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false,
  activity: { prompt: 'Implement HOU-4', last_message: 'Running the migration tests', tool: 'Bash', model: 'claude-opus-5-5' }
}], [42, {
  id: 42, agent: 'codex', state: 'running', status: 'needs-input', title: 'HOU-2', codename: 'asker', project_dir: '/work/app', cwd: '/work/app',
  hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, status_since_ms: 60_000,
  delegation: { hold_reason: 'Should I drop the legacy table?' }
} as unknown as SessionInfo]])

const MERGED_LINK = { url: 'https://github.com/acme/app/pull/58', number: 58, state: 'merged', checks: 'passing' } as PullRequestLink

function fakeClient(): { client: HoustonClient; sent: ClientMsg[]; emit: (message: ServerMsg) => void } {
  const handlers = new Map<string, Set<(message: ServerMsg) => void>>()
  const sent: ClientMsg[] = []
  const client = {
    subscribe: (type: string, handler: (message: ServerMsg) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => handlers.get(type)?.delete(handler)
    },
    send: (message: ClientMsg) => sent.push(message),
    inboxList: () => {},
    taskStartSettingsGet: (workspace: string) => sent.push({ type: 'task_start_settings_get', workspace })
  } as unknown as HoustonClient
  return { client, sent, emit: (message) => handlers.get(message.type)?.forEach((handler) => handler(message)) }
}

function renderFactory(overrides: Partial<FactorySurfaceProps> = {}): FactorySurfaceProps {
  const props: FactorySurfaceProps = {
    client: null, workspaces: [{ path: '/work/app', name: 'App' }, { path: '/work/other', name: 'Other' }], sessions: SESSIONS, now: NOW,
    pullRequests: [MERGED_LINK], onOpenSession: vi.fn(), onOpenTask: vi.fn(), onOpenPullRequest: vi.fn(), onOpenExternal: vi.fn(), onStartRequested: vi.fn(),
    ...overrides
  }
  render(<FactorySurface {...props} />)
  return props
}

describe('Factory page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useTasks.mockReturnValue({ snapshot: { scope: 'all', tasks: TASKS, counts: {} }, refusal: null, startTask: mocks.startTask })
  })
  afterEach(cleanup)

  it('lists what needs you oldest first: a waiting run, a question, then a review', () => {
    const props = renderFactory()
    const items = screen.getAllByTestId('factory-needs-item')
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual(['input', 'question', 'review'])
    expect(items[0]!.textContent).toContain('Codex asks: “Should I drop the legacy table?”')
    fireEvent.click(within(items[0]!).getByTestId('factory-open-pane'))
    expect(props.onOpenSession).toHaveBeenCalledWith(42)
    expect(within(items[1]!).getByText('Add a column · Recommended')).toBeTruthy()
    fireEvent.click(within(items[2]!).getByTestId('factory-review'))
    expect(props.onOpenTask).toHaveBeenCalledWith(3)
    fireEvent.click(screen.getByTestId('factory-next'))
    expect(document.activeElement).toBe(items[0])
  })

  it('answers a question with the option text without keyboard shortcuts', () => {
    const { client, sent } = fakeClient()
    renderFactory({ client })
    const question = screen.getAllByTestId('factory-needs-item').find((item) => item.getAttribute('data-kind') === 'question')!
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })) })
    expect(sent.some((message) => message.type === 'task_question_answer')).toBe(false)
    fireEvent.click(within(question).getAllByTestId('question-card-option')[1]!)
    expect(sent.at(-1)).toEqual({ type: 'task_question_answer', question_id: 31, answer: 'Create a table' })
  })

  it('shows each live run with its agent, model, worktree, phrase and time', () => {
    const props = renderFactory()
    const working = within(screen.getByTestId('factory-working'))
    const rows = working.getAllByTestId('data-table-row')
    expect(rows).toHaveLength(1)
    const text = rows[0]!.textContent
    for (const part of ['HOU-4', 'Runs now', 'Claude', 'claude-opus-5-5', 'houston/task/hou-4', 'Running the migration tests', '5m']) expect(text).toContain(part)
    fireEvent.click(working.getByRole('button', { name: 'Open pane' }))
    expect(props.onOpenSession).toHaveBeenCalledWith(44)
  })

  it('lists Slack requests with their intake chips', () => {
    renderFactory()
    const table = screen.getByRole('table', { name: 'Slack requests' })
    expect([...table.querySelectorAll('[data-testid="task-intake-chip"]')].map((chip) => chip.textContent)).toEqual(['Slack · awaiting ✅', 'Slack · queued #2'])
  })

  it('starts the selected ready tasks once each with their workspace default agent', () => {
    const { client, sent, emit } = fakeClient()
    const props = renderFactory({ client })
    expect(sent).toContainEqual({ type: 'task_start_settings_get', workspace: '/work/other' })
    act(() => emit({ type: 'task_start_settings', workspace: '/work/other', agent: 'codex', delivery: 'send' }))
    const backlog = screen.getByRole('table', { name: 'Ready backlog' })
    expect(within(backlog).getAllByTestId('data-table-row').map((row) => row.textContent?.includes('Ready'))).toEqual([true, true])
    const start = screen.getByTestId('factory-start-selected') as HTMLButtonElement
    expect(start.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select HOU-7' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select HOU-8' }))
    expect(start.textContent).toBe('Start selected (2)')
    fireEvent.click(start)
    expect(mocks.startTask.mock.calls).toEqual([[7, 'claude', '/work/app'], [8, 'codex', '/work/other']])
    expect(props.onStartRequested).toHaveBeenCalledTimes(2)
    expect(start.disabled).toBe(true)

    fireEvent.click(within(backlog).getAllByRole('button', { name: 'Start in worktree' })[0]!)
    expect(mocks.startTask).toHaveBeenLastCalledWith(7, 'claude', '/work/app')
  })

  it('names a refused start with its task key', () => {
    mocks.useTasks.mockReturnValue({ snapshot: { scope: 'all', tasks: TASKS, counts: {} }, refusal: { id: 7, kind: 'invalid', message: 'HOU-7 is not ready: no executable acceptance item', expected: null, actual: null, limit: null, requested: null }, startTask: mocks.startTask })
    renderFactory()
    expect(screen.getByText('HOU-7: HOU-7 is not ready: no executable acceptance item')).toBeTruthy()
  })

  it('lands pull requests with their tracked state and opens them in the app when tracked', () => {
    const props = renderFactory()
    const landing = within(screen.getByRole('table', { name: 'Landing' }))
    const rows = landing.getAllByTestId('data-table-row')
    expect(rows.map((row) => row.textContent?.includes('#58'))).toEqual([true, false])
    expect(rows[0]!.textContent).toContain('Merged')
    fireEvent.click(landing.getByRole('button', { name: '#58' }))
    expect(props.onOpenPullRequest).toHaveBeenCalledWith(MERGED_LINK)
    fireEvent.click(landing.getByRole('button', { name: '#57' }))
    expect(props.onOpenExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/57')
  })

  it('shows the limits with their counts and links to the setting', () => {
    const { client, sent, emit } = fakeClient()
    renderFactory({ client })
    expect(sent).toContainEqual({ type: 'factory_settings_get' })
    expect(screen.getByText('Loading limits…')).toBeTruthy()
    act(() => emit({ type: 'factory_settings', live_runs_max: 3, needs_you_max: 3, live_runs: 1, needs_you: 3 }))
    expect(screen.getByTestId('factory-live-runs').textContent).toBe('1 / 3')
    expect(screen.getByTestId('factory-needs-you-count').textContent).toBe('3 / 3')
    expect(screen.getByLabelText('Paused')).toBeTruthy()
    expect(screen.queryByLabelText('Waiting for a slot')).toBeNull()
    fireEvent.click(screen.getByTestId('factory-limits-settings'))
    expect(settingsNav.openSettings).toHaveBeenCalledWith('tasks')
  })
})
