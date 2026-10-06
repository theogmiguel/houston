// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import type { Task } from '../../houston/generated/Task'
import { TasksTab } from './TasksTab'
import { TaskStartCard } from './TaskExecution'
import { createSessionsStore, SessionsStoreContext } from '../../sessionsStore'
import type { SessionInfo } from '../../houston/client'
import type { TaskRun } from '../../houston/generated/TaskRun'
import { TaskNowCard } from './TaskNowCard'
import { TaskDetail } from './TaskDetail'

const mocks = vi.hoisted(() => ({ useTasks: vi.fn(), saveTask: vi.fn(), startTask: vi.fn() }))
vi.mock('../../houston/useTasks', () => ({
  useTasks: mocks.useTasks,
  useTaskStartSettings: () => ({ settings: { agent: 'claude', delivery: 'send' } })
}))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TASK: Task = {
  id: 7, workspace: null, number: 7, key: 'HOU-7', title: 'Global task', description: '',
  status: 'todo', priority: 'none', parent_id: null, ref_url: null, revision: 1,
  created_by: 'user', created_at_ms: 1, updated_at_ms: 1, archived_at_ms: null, links: [], blocked_by: []
}
const WORKSPACES = [{ path: '/project', name: 'Project' }, { path: '/other', name: 'Other' }]

function state() {
  return {
    snapshot: { scope: 'all', tasks: [
      { ...TASK, acceptance_checked: 0, acceptance_total: 0, children_total: 0, children_done: 0 },
      { ...TASK, id: 8, number: 8, key: 'HOU-8', workspace: '/other', acceptance_checked: 0, acceptance_total: 0, children_total: 0, children_done: 0 }
    ], counts: {} },
    detail: null, watched: null, access: 'off', refusal: null,
    watchTask: vi.fn(), openTask: vi.fn(), saveTask: mocks.saveTask, createTask: vi.fn(),
    setAccess: vi.fn(), startTask: mocks.startTask
  }
}

describe('global Tasks viewer', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.useTasks.mockReturnValue(state())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  const click = (selector: string): void => act(() => {
    const element = container.querySelector<HTMLElement>(selector)
    if (!element) throw new Error(`Missing ${selector}`)
    if (element.getAttribute('role') === 'combobox') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    else element.click()
  })

  it('defaults to All, shows workspace chips, and remembers the viewer scope', () => {
    act(() => root.render(<TasksTab client={null} workspace="/project" workspaces={WORKSPACES} />))
    expect(mocks.useTasks.mock.calls.at(-1)?.slice(1)).toEqual(['/project', 'all'])
    // The scope toggle replaces the workspace breadcrumb in the single header bar.
    expect(container.querySelectorAll('.tk-head')).toHaveLength(1)
    expect(container.querySelector('.tk-head .crumb2')).toBeNull()
    expect(container.querySelector('.tk-head [role="radio"]')).not.toBeNull()
    expect([...container.querySelectorAll('[data-testid="task-workspace-chip"]')].map((item) => item.textContent))
      .toEqual(['other', 'No workspace'])
    // The chip is an extra grid cell; without the `ws` column the right slot wraps onto a second line.
    expect([...container.querySelectorAll('[data-testid="task-workspace-chip"]')]
      .every((chip) => chip.closest('.tk-row')?.classList.contains('ws'))).toBe(true)
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === 'This workspace')!.click())
    expect(mocks.useTasks.mock.calls.at(-1)?.slice(1)).toEqual(['/project', '/project'])
    expect(container.querySelector('[data-testid="task-workspace-chip"]')).toBeNull()
    expect(localStorage.getItem('houston.tasks.scope:/project')).toBe('workspace')
    act(() => root.unmount())
    root = createRoot(container)
    act(() => root.render(<TasksTab client={null} workspace="/project" workspaces={WORKSPACES} />))
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('This workspace')
  })

  it.each([
    ['C:\\Programação\\Houston', 'Houston'],
    ['C:\\Programação\\Houston\\', 'Houston'],
    ['\\\\server\\projects\\Houston', 'Houston'],
    ['/projects/Houston/', 'Houston']
  ])('shows the folder name for workspace %s', (workspace, name) => {
    const snapshot = state()
    snapshot.snapshot.tasks[1].workspace = workspace
    mocks.useTasks.mockReturnValue(snapshot)
    act(() => root.render(<TasksTab client={null} workspace={workspace} />))
    expect(container.querySelector('[data-testid="task-workspace-chip"]')?.textContent).toBe(name)
  })

  it('keeps scope controls usable when localStorage refuses writes', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    act(() => root.render(<TasksTab client={null} workspace="/project" />))
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent === 'This workspace')!.click())
    expect(mocks.useTasks.mock.calls.at(-1)?.[2]).toBe('/project')
    setItem.mockRestore()
  })

  it('requires a workspace for an unassigned Start and passes the chosen path', () => {
    const onStart = vi.fn()
    act(() => root.render(<TaskStartCard task={TASK} settings={null} readOnly={false}
      workspaceOptions={WORKSPACES.map((workspace) => ({ value: workspace.path, label: workspace.name }))} onStart={onStart} />))
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-start"]')!.disabled).toBe(true)
    click('[data-testid="task-start-workspace"]')
    act(() => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Other')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-start"]')!.disabled).toBe(false)
    click('[data-testid="task-start"]')
    expect(onStart).toHaveBeenCalledWith(7, 'claude', '/other')
  })

  it('allows the user to assign and clear the workspace regardless of agent access', () => {
    const onSave = vi.fn()
    const renderDetail = (workspace: string | null): void => act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, workspace }, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null}
      workspaceOptions={WORKSPACES.map((item) => ({ value: item.path, label: item.name }))}
      onBack={vi.fn()} onReload={vi.fn()} onSave={onSave} onCheck={vi.fn()} onComment={vi.fn()}
      onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    renderDetail(null)
    click('[data-testid="task-workspace"]')
    act(() => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'Project')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(onSave).toHaveBeenLastCalledWith(7, 1, { workspace: '/project' })
    renderDetail('/project')
    click('[data-testid="task-workspace"]')
    act(() => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === 'No workspace')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
    expect(onSave).toHaveBeenLastCalledWith(7, 1, { workspace: null })
  })
  it('reviews the live session after leaf events while task cards follow the task run stream', () => {
    const session: SessionInfo = { id: 1, agent: 'claude', state: 'running', status: 'working', codename: 'worker', title: 'worker', project_dir: '/project', cwd: '/project', hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, task: { task_id: 7, key: 'HOU-7', title: 'Global task', status: 'in_progress', run_id: 3, run_state: 'running' } }
    const sessions = new Map([[1, session]])
    const store = createSessionsStore(sessions)
    const onReview = vi.fn()
    const run: TaskRun = { id: 3, task_id: 7, attempt: 1, kind: 'implementation', state: 'running', provider: 'claude', session_id: 1, initial_revision: 1, started_at_ms: 1 }
    const renderCards = (currentRun: TaskRun) => act(() => root.render(<SessionsStoreContext.Provider value={store}>
      <TaskNowCard session={session} summary={{ ...TASK, status: 'in_progress', open_run: currentRun, acceptance_checked: 0, acceptance_total: 0, children_total: 0, children_done: 0 }} detail={null} onOpenSession={vi.fn()} onStop={vi.fn()} />
      <TaskDetail detail={{ task: TASK, acceptance: [], comments: [], history: [], runs: [currentRun] }} access="off" refusal={null} now={1} parentOptions={[]} sessions={sessions} startSettings={null} onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()} onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={onReview} />
    </SessionsStoreContext.Provider>))
    renderCards(run)
    const current = { ...session, status: 'needs-input' as const, live_children: 2 }
    act(() => store.set((previous) => new Map(previous).set(1, current)))
    click('[data-testid="task-run-review"]')
    expect(onReview).toHaveBeenLastCalledWith(current)
    expect(onReview.mock.calls.at(-1)?.[0]).toBe(current)
    expect(container.querySelector('[data-testid="tasks-now"] .tk-st')?.textContent).toBe('In progress')
    renderCards({ ...run, state: 'waiting_for_input' })
    expect(container.querySelector('[data-testid="tasks-now"] .tk-st')?.textContent).toBe('Needs you')
    expect(container.querySelector('[data-testid="task-execution"] .tk-st')?.textContent).toBe('Needs you')
  })

  it('renders the drawer detail with the mock actions and toggleable acceptance rows', () => {
    const onOpenSession = vi.fn()
    const onRunControl = vi.fn()
    const onCheck = vi.fn()
    const session: SessionInfo = { id: 1, agent: 'claude', state: 'exited', title: 'HOU-7', codename: 'worker', project_dir: '/project', cwd: '/project', hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: true }
    const run: TaskRun = { id: 3, task_id: 7, attempt: 1, kind: 'implementation', state: 'cancelled', provider: 'claude', session_id: 1, branch: 'houston/task/hou-7', initial_revision: 1, started_at_ms: 1, ended_at_ms: 1 }
    act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, workspace: '/project', origin: { kind: 'harness_finding', workspace: '/project', key: 'bun-test', review_id: 1 } }, acceptance: [{ id: 5, position: 0, text: 'Run bun run test', checked_at_ms: null, checked_by: null }], comments: [], history: [], runs: [run] }}
      access="off" refusal={null} now={15 * 60_000} parentOptions={[]} sessions={new Map([[1, session]])} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={onCheck} onComment={vi.fn()} onArchive={vi.fn()} onStart={vi.fn()} onRunControl={onRunControl} onOpenSession={onOpenSession} onReview={vi.fn()} presentation="drawer"
    />))
    expect(screen.getByRole('heading', { name: 'Global task' })).toBeTruthy()
    expect(screen.getByText('HOU-7')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Task progress' })).toBeTruthy()
    expect(container.querySelector('[data-task-drawer-run-meta]')?.textContent).toBe('Stopped 14m ago · Attempt 1 · Claude Code')
    expect(container.querySelector('[data-task-drawer-run-reuse]')?.textContent).toBe('Reuses houston/task/hou-7 · no pull request yet')
    const startAgain = screen.getByRole('button', { name: 'Start again' })
    const review = screen.getByRole('button', { name: 'Review changes' })
    expect(startAgain.className).toContain('h-[var(--h-ctl)]')
    expect(review.className).toContain('h-[var(--h-ctl)]')
    expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull()
    click('[data-testid="task-detail-menu"]')
    act(() => screen.getByRole('menuitem', { name: 'Open session' }).click())
    expect(onOpenSession).toHaveBeenCalledWith(1)
    const acceptance = screen.getByRole('checkbox', { name: 'Run bun run test' })
    act(() => acceptance.click())
    expect(onCheck).toHaveBeenCalledWith(7, 5, true)
    expect(screen.getByText('From Harness finding · bun-test')).toBeTruthy()
  })

  it('offers Start anyway on a not-ready refusal and repeats the Start with force', () => {
    const onStart = vi.fn()
    const task = { ...TASK, workspace: '/project', links: [{ provider: 'github', external_id: 'o/r#12', url: 'https://github.com/o/r/issues/12' }] }
    const render = (refusal: Parameters<typeof TaskDetail>[0]['refusal']): void => act(() => root.render(
      <TaskDetail detail={{ task, acceptance: [], comments: [], history: [], runs: [] }} access="write" refusal={refusal} now={1} parentOptions={[]} sessions={new Map()} startSettings={{ agent: 'codex', delivery: 'send' }} onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()} onArchive={vi.fn()} onStart={onStart} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} />
    ))
    render(null)
    expect(container.querySelector('[data-testid="task-links"]')?.textContent).toBe('GitHub · o/r#12')
    click('[data-testid="task-start"]')
    expect(onStart).toHaveBeenLastCalledWith(7, 'codex', null)
    render({ id: 7, kind: 'not_ready', message: 'task_start refused: task HOU-7 is not ready; it needs at least one acceptance item', expected: null, actual: null, limit: null, requested: null })
    expect(container.querySelector('[data-testid="task-not-ready-banner"]')?.textContent).toContain('at least one acceptance item')
    click('[data-testid="task-start-anyway"]')
    expect(onStart).toHaveBeenLastCalledWith(7, 'codex', null, true)
  })
  it('offers Open GitHub issue only while the task mirrors no issue', () => {
    const onOpenIssue = vi.fn()
    const render = (links: typeof TASK.links): void => act(() => root.render(
      <TaskDetail detail={{ task: { ...TASK, links }, acceptance: [], comments: [], history: [], runs: [] }} access="write" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null} onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()} onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenIssue={onOpenIssue} onOpenSession={vi.fn()} onReview={vi.fn()} />
    ))
    render([])
    click('[data-testid="task-detail-menu"]')
    act(() => screen.getByRole('menuitem', { name: 'Open GitHub issue' }).click())
    expect(onOpenIssue).toHaveBeenCalledWith(7)
    render([{ provider: 'github', external_id: 'o/r#12', url: null }])
    click('[data-testid="task-detail-menu"]')
    expect(screen.queryByRole('menuitem', { name: 'Open GitHub issue' })).toBeNull()
  })
})
