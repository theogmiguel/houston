// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, type LayoutNode } from './layout/tree'
import { openSideTasks } from './sidePanel'
import type { TaskRun } from './houston/generated/TaskRun'
import {
  type AppHarness,
  currentClient,
  deliverClientMsg,
  deliverControl,
  deliverHelloOk,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'
const WORKTREE = '/tmp/project/.houston/worktrees/hou-1-fix'
const GRID_KEY = gridStorageKey(WS, DEFAULT_GRID_ID)

beforeAll(async () => {
  await import('./components/ChangesPane')
  await import('./components/tasks/TasksTab')
})

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

function sessionsIn(node: LayoutNode | null): number[] {
  if (!node) return []
  if (node.kind === 'leaf') return [node.session]
  if (node.kind === 'split' || node.kind === 'stack')
    return (node.children as LayoutNode[]).flatMap(sessionsIn)
  return []
}

function storedOrder(): number[] {
  const raw = localStorage.getItem(`tr-layout:${GRID_KEY}`)
  return sessionsIn(raw ? (JSON.parse(raw).tree as LayoutNode | null) : null)
}

const TASK = {
  id: 7,
  workspace: WS,
  number: 1,
  key: 'HOU-1',
  title: 'Fix login',
  status: 'todo',
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

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 11,
    task_id: TASK.id,
    attempt: 1,
    kind: 'implementation',
    state: 'running',
    provider: 'claude',
    session_id: 3,
    worktree_path: WORKTREE,
    branch: 'houston/task/hou-1-fix',
    initial_revision: 1,
    started_at_ms: 1,
    ...overrides
  }
}

describe('Start places the pane the daemon creates', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  async function boot(): Promise<void> {
    harness = await renderReadyApp()
    deliverHelloOk({
      sessions: [1, 2].map((id) => makeSession({ id, project_dir: WS, cwd: WS })),
      workspaces: [makeWorkspace({ path: WS, name: 'project' })]
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  const q = (selector: string): HTMLElement | null =>
    harness!.container.querySelector<HTMLElement>(selector)

  async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 240; i++) {
      if (check()) return
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    throw new Error(`${what} never appeared`)
  }

  async function clickStart(): Promise<void> {
    act(() => openSideTasks())
    await until(() => q('[data-testid="nav-surface"][data-page="tasks"]') !== null, 'Tasks page')
    deliverClientMsg('tasks_access', { type: 'tasks_access', workspace: 'all', access: 'write' })
    deliverClientMsg('tasks_access', { type: 'tasks_access', workspace: WS, access: 'write' })
    deliverClientMsg('task_start_settings', {
      type: 'task_start_settings',
      workspace: WS,
      agent: 'claude',
      delivery: 'send'
    })
    const snapshot = {
      type: 'task_snapshot',
      scope: 'all',
      counts: { ready: 1, backlog: 0, todo: 1, in_progress: 0, in_review: 0, done: 0, canceled: 0 },
      tasks: [TASK]
    }
    deliverClientMsg('task_snapshot', snapshot)
    deliverClientMsg('task_snapshot', { ...snapshot, scope: WS })
    const taskTitle = (): HTMLButtonElement | null =>
      Array.from(harness!.container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === TASK.title) ?? null
    await until(() => taskTitle() !== null, 'task row')
    act(() => taskTitle()!.click())
    deliverClientMsg('task_detail', {
      type: 'task_detail',
      task: { ...TASK, description: '', links: [] },
      acceptance: [],
      comments: [],
      history: [],
      runs: []
    })
    const startButton = (): HTMLButtonElement | null => document.querySelector('[data-testid="task-start"]')
    await until(() => startButton() !== null, 'Start button')
    act(() => startButton()!.click())
  }

  function focusPane(session: number): void {
    const pane = q(`[data-panekey="${session}"]`)?.closest('.pane-slot')?.querySelector('.pane')
    if (!(pane instanceof HTMLElement)) throw new Error(`no .pane for session ${session}`)
    act(() => {
      pane.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
  }

  it('puts the new pane beside the focused one, keeps every pane, and focuses it', async () => {
    await boot()
    expect(storedOrder()).toEqual([1, 2])
    const taskStart = vi.fn()
    ;(currentClient() as unknown as { taskStart: typeof taskStart }).taskStart = taskStart
    focusPane(1)
    await clickStart()
    expect(taskStart.mock.calls[0].slice(0, 2)).toEqual([TASK.id, 'claude'])

    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 3, agent: 'claude', project_dir: WS, cwd: WORKTREE, title: 'HOU-1 Fix login' })
    })
    deliverClientMsg('task_run_changed', { type: 'task_run_changed', run: run() })

    expect(storedOrder()).toEqual([1, 3, 2])
    expect(q('[data-panekey="1"]')).not.toBeNull()
    expect(q('[data-panekey="2"]')).not.toBeNull()
    expect(q('[data-panekey="3"]')).not.toBeNull()
    const focused = q('section.pane.focus[data-panekey]')
    expect(focused?.getAttribute('data-panekey')).toBe('3')
    expect(q('[data-testid="nav-surface"][data-page="tasks"]')).not.toBeNull()
  })

  it('leaves a run started elsewhere to the default placement', async () => {
    await boot()
    focusPane(1)
    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 3, agent: 'claude', project_dir: WS, cwd: WORKTREE })
    })
    deliverClientMsg('task_run_changed', { type: 'task_run_changed', run: run() })

    expect(storedOrder()).toEqual([1, 2, 3])
  })
})
