// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoustonClient } from './client'
import type { ServerMsg } from './generated/ServerMsg'
import { useTasks } from './useTasks'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeClient() {
  const handlers = new Map<string, Set<(msg: ServerMsg) => void>>()
  const client = {
    subscribe: (kind: string, handler: (msg: ServerMsg) => void) => {
      const set = handlers.get(kind) ?? new Set()
      set.add(handler)
      handlers.set(kind, set)
      return () => set.delete(handler)
    },
    taskSnapshot: vi.fn(),
    taskGet: vi.fn(),
    taskSave: vi.fn(),
    taskComment: vi.fn(),
    taskCheck: vi.fn(),
    taskArchive: vi.fn(),
    tasksAccessGet: vi.fn(),
    tasksAccessSet: vi.fn()
  }
  const emit = (msg: ServerMsg): void => {
    act(() => handlers.get(msg.type)?.forEach((handler) => handler(msg)))
  }
  return { client, emit, asClient: client as unknown as HoustonClient }
}

function Probe({ client, workspace, scope }: { client: HoustonClient; workspace: string | null; scope?: string }): React.JSX.Element {
  const tasks = useTasks(client, workspace, scope)
  return (
    <div>
      <output data-testid="snapshot-count">{tasks.snapshot?.tasks.length ?? -1}</output>
      <output data-testid="detail-title">{tasks.detail?.task.title ?? ''}</output>
      <output data-testid="refusal-kind">{tasks.refusal?.kind ?? ''}</output>
      <output data-testid="access">{tasks.access ?? ''}</output>
      <button onClick={() => tasks.openTask(7)}>Open</button>
      <button onClick={() => tasks.reloadTask(7)}>Reload</button>
      <button onClick={() => tasks.closeTask()}>Close</button>
      <button onClick={() => tasks.createTask({ title: 'New' })}>Create</button>
    </div>
  )
}

const SNAPSHOT: Extract<ServerMsg, { type: 'task_snapshot' }> = {
  type: 'task_snapshot',
  scope: '/w',
  counts: { ready: 0, backlog: 1, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0 },
  tasks: [
    {
      id: 7,
      workspace: '/w',
      number: 7,
      key: 'HOU-7',
      title: 'from snapshot',
      status: 'backlog',
      priority: 'none',
      parent_id: null,
      ref_url: null,
      revision: 1,
      created_by: 'user',
      created_at_ms: 1,
      updated_at_ms: 1,
      archived_at_ms: null,
      acceptance_checked: 0,
      acceptance_total: 0
    }
  ]
}

const DETAIL: Extract<ServerMsg, { type: 'task_detail' }> = {
  type: 'task_detail',
  task: { ...SNAPSHOT.tasks[0], title: 'from detail', description: '' },
  acceptance: [],
  comments: [],
  history: [],
  runs: []
}

describe('useTasks', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reads global tasks from other workspaces and refreshes when a binding is cleared', () => {
    const { client, emit, asClient } = fakeClient()
    act(() => root.render(<Probe client={asClient} workspace="/w" scope="all" />))
    expect(client.taskSnapshot).toHaveBeenCalledWith('all')
    emit({ ...SNAPSHOT, scope: 'all', tasks: [{ ...SNAPSHOT.tasks[0], workspace: '/other' }] })
    expect(container.querySelector('[data-testid="snapshot-count"]')?.textContent).toBe('1')
    act(() => container.querySelector('button')!.click())
    emit({ ...DETAIL, task: { ...DETAIL.task, workspace: '/other' } })
    expect(container.querySelector('[data-testid="detail-title"]')?.textContent).toBe('from detail')
    client.taskSnapshot.mockClear()
    emit({ type: 'task_changed', workspace: null, id: 7, revision: 2 })
    expect(client.taskSnapshot).toHaveBeenCalledWith('all')
  })

  it('creates unassigned tasks when no workspace is selected', () => {
    const { client, asClient } = fakeClient()
    act(() => root.render(<Probe client={asClient} workspace={null} scope="all" />))
    act(() => container.querySelectorAll('button')[3].click())
    expect(client.taskSave).toHaveBeenCalledWith(null, null, null, { title: 'New' })
  })

  it('reads the snapshot and access on mount, refetches on a change, and reloads the open task', () => {
    const { client, emit, asClient } = fakeClient()
    act(() => root.render(<Probe client={asClient} workspace="/w" />))
    expect(client.taskSnapshot).toHaveBeenCalledWith('/w')
    expect(client.tasksAccessGet).toHaveBeenCalledWith('/w')

    emit(SNAPSHOT)
    emit({ ...SNAPSHOT, scope: '/other', tasks: [] })
    expect(container.querySelector('[data-testid="snapshot-count"]')?.textContent).toBe('1')

    act(() => container.querySelector('button')!.click())
    expect(client.taskGet).toHaveBeenCalledWith(7)
    emit(DETAIL)
    expect(container.querySelector('[data-testid="detail-title"]')?.textContent).toBe('from detail')

    client.taskSnapshot.mockClear()
    client.taskGet.mockClear()
    emit({ type: 'task_changed', workspace: '/w', id: 7, revision: 2 })
    expect(client.taskSnapshot).toHaveBeenCalledWith('/w')
    expect(client.taskGet).toHaveBeenCalledWith(7)

    emit({ type: 'task_refused', id: 7, kind: 'conflict', expected: 1, actual: 2, message: 'stale' })
    expect(container.querySelector('[data-testid="refusal-kind"]')?.textContent).toBe('conflict')
    client.taskGet.mockClear()
    act(() => container.querySelectorAll('button')[1].click())
    expect(client.taskGet).toHaveBeenCalledWith(7)
    emit(DETAIL)
    expect(container.querySelector('[data-testid="refusal-kind"]')?.textContent).toBe('')

    emit({ type: 'tasks_access', workspace: '/w', access: 'read' })
    expect(container.querySelector('[data-testid="access"]')?.textContent).toBe('read')
  })
})
