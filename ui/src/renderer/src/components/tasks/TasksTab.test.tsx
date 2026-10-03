// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../houston/generated/Task'
import { TasksTab } from './TasksTab'
import { TaskStartCard } from './TaskExecution'
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
      { ...TASK, id: 8, number: 8, key: 'HOU-8', workspace: '/other', acceptance_checked: 0, acceptance_total: 0 }
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
})
