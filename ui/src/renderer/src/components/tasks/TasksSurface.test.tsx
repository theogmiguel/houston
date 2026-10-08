// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { Task } from '../../houston/generated/Task'
import { TasksSurface } from '../nav/TasksSurface'
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
  created_by: 'user', created_at_ms: 1, updated_at_ms: 1, archived_at_ms: null
}
const WORKSPACES = [{ path: '/project', name: 'Project' }, { path: '/other', name: 'Other' }]

function state() {
  return {
    snapshot: { scope: 'all', tasks: [
      { ...TASK, acceptance_checked: 0, acceptance_total: 0 },
      { ...TASK, id: 8, number: 8, key: 'HOU-8', title: 'Other task', workspace: '/other', acceptance_checked: 0, acceptance_total: 0 }
    ], counts: {} },
    detail: null, watched: null, access: 'off', refusal: null,
    watchTask: vi.fn(), openTask: vi.fn(), saveTask: mocks.saveTask, createTask: vi.fn(),
    setAccess: vi.fn(), startTask: mocks.startTask
  }
}

// The drawer renders descriptions through the lazy markdown pipeline; a cold import can outlast waitFor.
beforeAll(async () => {
  await import('../markdownPipeline')
})

describe('Tasks surface and drawer', () => {
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

  it('keeps an existing task URL labelled as a source link rather than inferring a PR', () => {
    act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, ref_url: 'https://github.com/acme/app/issues/7' }, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()}
      onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    const source = screen.getByRole('link', { name: 'Task source' })
    expect(source.getAttribute('href')).toBe('https://github.com/acme/app/issues/7')
  })

  it('lists the selected workspace queue beside the detail of the selected task', () => {
    const snapshot = state()
    const openTask = vi.fn()
    snapshot.openTask = openTask
    mocks.useTasks.mockReturnValue(snapshot)
    act(() => root.render(<TasksSurface client={null} workspace="/project" workspaces={WORKSPACES} sessions={new Map()} now={1}
      onStartRequested={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} onOpenExternal={vi.fn()} />))
    expect(mocks.useTasks.mock.calls.at(-1)?.slice(1)).toEqual(['/project', '/project'])
    expect(container.querySelector('[data-testid="list-detail"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="task-detail-drawer"], [role="dialog"]')).toBeNull()
    const items = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="list-detail-item"]')]
    expect(items.map((item) => item.firstElementChild?.textContent)).toEqual(['Other task', 'Global task'])
    expect(openTask).toHaveBeenLastCalledWith(8)
    act(() => items[1].click())
    expect(openTask).toHaveBeenLastCalledWith(7)
    expect(screen.getByRole('status').textContent).toBe('Loading task…')
  })

  it('says a task stopped just now rather than "now ago"', () => {
    const snapshot = state()
    snapshot.snapshot.tasks = [{ ...TASK, status: 'in_progress', updated_at_ms: 1, acceptance_checked: 0, acceptance_total: 1 }]
    mocks.useTasks.mockReturnValue(snapshot)
    act(() => root.render(<TasksSurface client={null} workspace="/project" workspaces={WORKSPACES} sessions={new Map()} now={1}
      onStartRequested={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} onOpenExternal={vi.fn()} />))
    const meta = container.querySelector('[data-testid="list-detail-item"]')!.textContent
    expect(meta).toContain('stopped just now')
    expect(meta).not.toContain('now ago')
  })

  it('expands finished tasks below the Done and archived toggle', () => {
    const snapshot = state()
    snapshot.snapshot.tasks = [
      { ...TASK, acceptance_checked: 0, acceptance_total: 0 },
      { ...TASK, id: 9, number: 9, key: 'HOU-9', title: 'Shipped task', status: 'done', acceptance_checked: 0, acceptance_total: 0 }
    ]
    mocks.useTasks.mockReturnValue(snapshot)
    act(() => root.render(<TasksSurface client={null} workspace="/project" workspaces={WORKSPACES} sessions={new Map()} now={1}
      onStartRequested={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} onOpenExternal={vi.fn()} />))
    click('[data-testid="tasks-show-finished"]')
    const toggle = container.querySelector('[data-testid="tasks-show-finished"]')!
    const shipped = [...container.querySelectorAll('[data-testid="list-detail-item"]')].find((item) => item.textContent?.includes('Shipped task'))!
    expect(toggle.compareDocumentPosition(shipped) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens a task once the daemon confirms its creation', () => {
    const snapshot = state()
    const openTask = vi.fn()
    const createTask = vi.fn()
    snapshot.openTask = openTask
    snapshot.createTask = createTask
    mocks.useTasks.mockReturnValue(snapshot)
    act(() => root.render(<TasksSurface client={null} workspace="/project" workspaces={WORKSPACES} sessions={new Map()} now={1}
      onStartRequested={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()} onOpenExternal={vi.fn()} />))
    act(() => screen.getByRole('button', { name: 'New task' }).click())
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'Cap retries' } })
    act(() => screen.getByRole('button', { name: 'Create task' }).click())
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: 'Cap retries' }), expect.any(Function))
    act(() => createTask.mock.calls[0][1](42))
    expect(openTask).toHaveBeenLastCalledWith(42)
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

  it('renders a multiline task description and a routed URL link in the drawer', async () => {
    const description = Array.from({ length: 10 }, (_, index) => `Paragraph ${index + 1} with details.`).join('\n\n') + '\n\n[Issue 96](https://example.com/issues/96)'
    act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, description }, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()}
      onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    const descriptionNode = container.querySelector('[data-testid="task-description"]')
    expect(descriptionNode).not.toBeNull()
    await waitFor(() => expect(descriptionNode?.querySelectorAll('p').length).toBeGreaterThanOrEqual(10))
    expect(descriptionNode?.querySelector('a[href="https://example.com/issues/96"][data-tr-link="external"]')).not.toBeNull()
    expect([...descriptionNode!.querySelectorAll('div')].some((node) => node.className.includes('line-clamp-[8]'))).toBe(true)
  })

  it('clamps long descriptions to eight lines and expands and collapses them', () => {
    const description = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n')
    act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, description }, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()}
      onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    const descriptionNode = container.querySelector('[data-testid="task-description"]')!
    const clamp = [...descriptionNode.querySelectorAll<HTMLElement>('div')].find((node) => node.className.includes('line-clamp-[8]'))
    expect(clamp).toBeDefined()
    expect(container.querySelector('[data-testid="task-description"] .relative')?.getAttribute('style')).toContain('12.4em')
    act(() => screen.getByRole('button', { name: 'Show more' }).click())
    expect(container.querySelector('[data-testid="task-description"] .relative')?.getAttribute('style')).toContain('1fr')
    act(() => screen.getByRole('button', { name: 'Show less' }).click())
    expect(container.querySelector('[data-testid="task-description"] .relative')?.getAttribute('style')).toContain('12.4em')
  })

  it('saves description edits on blur without changing status or starting execution', () => {
    const onSave = vi.fn()
    const onStart = vi.fn()
    act(() => root.render(<TaskDetail
      detail={{ task: { ...TASK, description: 'Original description' }, acceptance: [], comments: [], history: [], runs: [] }}
      access="off" refusal={null} now={1} parentOptions={[]} sessions={new Map()} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={onSave} onCheck={vi.fn()} onComment={vi.fn()}
      onArchive={vi.fn()} onStart={onStart} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    act(() => screen.getByRole('button', { name: 'Edit description' }).click())
    const editor = screen.getByRole('textbox', { name: 'Task description' })
    fireEvent.change(editor, { target: { value: 'Updated description' } })
    act(() => editor.blur())
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(7, 1, { description: 'Updated description' })
    expect(onStart).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Task progress"]')?.textContent).toContain('Backlog')
  })

  it('shows activity comments and submits a new comment from the drawer', () => {
    const onComment = vi.fn()
    act(() => root.render(<TaskDetail
      detail={{ task: TASK, acceptance: [], comments: [{ id: 12, author: 'you', body: 'Existing note', created_at_ms: 2 }], history: [], runs: [] }}
      access="off" refusal={null} now={3} parentOptions={[]} sessions={new Map()} startSettings={null}
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={onComment}
      onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={vi.fn()}
    />))
    expect(screen.getByText('Existing note')).toBeTruthy()
    const composer = screen.getByRole('textbox', { name: 'Leave a comment' })
    fireEvent.change(composer, { target: { value: 'New note' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    expect(onComment).toHaveBeenCalledWith(7, 'New note')
  })
  it('reviews the live session after leaf events while task cards follow the task run stream', () => {
    const session: SessionInfo = { id: 1, agent: 'claude', state: 'running', status: 'working', codename: 'worker', title: 'worker', project_dir: '/project', cwd: '/project', hidden: false, live_children: 0, children_waiting: 0, inbox_unread: 0, tags: [], resumable: false, task: { task_id: 7, key: 'HOU-7', title: 'Global task', status: 'in_progress', run_id: 3, run_state: 'running' } }
    const sessions = new Map([[1, session]])
    const store = createSessionsStore(sessions)
    const onReview = vi.fn()
    const run: TaskRun = { id: 3, task_id: 7, attempt: 1, kind: 'implementation', state: 'running', provider: 'claude', session_id: 1, initial_revision: 1, started_at_ms: 1 }
    const renderCards = (currentRun: TaskRun) => act(() => root.render(<SessionsStoreContext.Provider value={store}>
      <TaskNowCard session={session} summary={{ ...TASK, status: 'in_progress', open_run: currentRun, acceptance_checked: 0, acceptance_total: 0 }} detail={null} onOpenSession={vi.fn()} onStop={vi.fn()} />
      <TaskDetail detail={{ task: TASK, acceptance: [], comments: [], history: [], runs: [currentRun] }} access="off" refusal={null} now={1} parentOptions={[]} sessions={sessions} startSettings={null} onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={vi.fn()} onComment={vi.fn()} onArchive={vi.fn()} onStart={vi.fn()} onRunControl={vi.fn()} onOpenSession={vi.fn()} onReview={onReview} />
    </SessionsStoreContext.Provider>))
    renderCards(run)
    const current = { ...session, status: 'needs-input' as const, live_children: 2 }
    act(() => store.set((previous) => new Map(previous).set(1, current)))
    click('[data-testid="task-run-review"]')
    expect(onReview).toHaveBeenLastCalledWith(current)
    expect(onReview.mock.calls.at(-1)?.[0]).toBe(current)
    expect(container.querySelector('[data-testid="tasks-now"] [data-run-state]')?.textContent).toBe('In progress')
    renderCards({ ...run, state: 'waiting_for_input' })
    expect(container.querySelector('[data-testid="tasks-now"] [data-run-state]')?.textContent).toBe('Needs you')
    expect(container.querySelector('[data-testid="task-execution"]')?.textContent).toContain('Needs you')
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
      onBack={vi.fn()} onReload={vi.fn()} onSave={vi.fn()} onCheck={onCheck} onComment={vi.fn()} onArchive={vi.fn()} onStart={vi.fn()} onRunControl={onRunControl} onOpenSession={onOpenSession} onReview={vi.fn()}
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

})
