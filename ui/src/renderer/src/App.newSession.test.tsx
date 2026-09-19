// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gridStorageKey, preorderSessions } from './layout/tree'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

function click(el: Element | null | undefined, what: string): void {
  if (!el) throw new Error(`${what} not found`)
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function openComposer(container: Element): void {
  const plus = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === 'New pane'
  )
  click(plus, 'a pane header’s "+" button')
  click(container.querySelector('[data-testid="add-pane-new-session"]'), 'the "New session…" row')
}

let harness: AppHarness | null = null

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})
afterEach(() => {
  harness?.unmount()
  harness = null
  vi.clearAllMocks()
})

describe('step 3 — the "New session" composer launches into the open workspace', () => {
  it('the Add-pane popover offers it, and submitting spawns one session per slot', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const client = currentClient()
    const createSession = client.createSession as ReturnType<typeof vi.fn>
    createSession.mockClear()

    openComposer(container)
    expect(container.querySelector('[data-testid="new-session-composer"]')).not.toBeNull()

    click(container.querySelector('[data-preset="workbench"]'), 'the Workbench preset')
    const task = container.querySelector<HTMLTextAreaElement>('[data-testid="new-session-task"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(task, 'Fix the parser')
      task.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click(container.querySelector('[data-testid="new-session-launch"]'), 'Launch')

    expect(createSession).toHaveBeenCalledTimes(2)
    const [first, second] = createSession.mock.calls.map((c) => c[0])
    expect(first.agent).toBe('claude')
    expect(first.prompt).toBe('Fix the parser')
    expect(second.agent).toBe('shell')
    expect(second.prompt).toBeNull()
    expect(first.project_dir).toBe(second.project_dir)

    expect(container.querySelector('[data-testid="new-session-composer"]')).toBeNull()
  })

  it('an empty task sends no prompt at all — the CLI opens idle', async () => {
    harness = await renderReadyApp()
    const { container } = harness
    const createSession = currentClient().createSession as ReturnType<typeof vi.fn>
    createSession.mockClear()

    openComposer(container)
    click(container.querySelector('[data-testid="new-session-launch"]'), 'Launch')

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(createSession.mock.calls[0][0].prompt).toBeNull()
  })
})

describe('where the composer lands its launch', () => {
  const WS = '/tmp/project'
  const gridsOf = (): { id: string; name: string }[] =>
    JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]')

  function clickWsPlus(container: Element): void {
    const plus = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('data-testid') === 'ws-new-session'
    )
    click(plus, 'the workspace row’s "+" button')
  }

  it('the workspace row "+" makes a new grid on submit, and the session lands in it', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    const { container } = harness
    expect(gridsOf()).toHaveLength(1)

    clickWsPlus(container)
    expect(container.querySelector('[data-testid="new-session-composer"]')).not.toBeNull()
    expect(gridsOf()).toHaveLength(1)

    click(container.querySelector('[data-testid="new-session-launch"]'), 'Launch')
    const grids = gridsOf()
    expect(grids).toHaveLength(2)

    deliverControl({
      type: 'session_created',
      info: makeSession({ id: 2, project_dir: WS, cwd: WS, agent: 'claude' })
    })
    await act(async () => {
      await Promise.resolve()
    })

    const layoutOf = (gridId: string): number[] => {
      const raw = localStorage.getItem(`tr-layout:${gridStorageKey(WS, gridId)}`)
      return raw ? preorderSessions(JSON.parse(raw).tree) : []
    }
    expect(layoutOf(grids[1].id)).toContain(2)
    expect(layoutOf(grids[0].id)).not.toContain(2)
  })

  it('cancelling the "+" composer leaves no empty "Untitled" behind', async () => {
    harness = await renderReadyApp({
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    const { container } = harness

    clickWsPlus(container)
    click(container.querySelector('[data-testid="new-session-cancel"]'), 'Cancel')

    expect(container.querySelector('[data-testid="new-session-composer"]')).toBeNull()
    expect(gridsOf()).toHaveLength(1)
  })

  it('the empty-workspace "New session" still launches into the grid on screen', async () => {
    harness = await renderReadyApp({ sessions: [], workspaces: [makeWorkspace({ path: WS })] })
    const { container } = harness

    click(
      container.querySelector('[data-testid="workspace-empty-new-session"]'),
      'the empty workspace’s "New session" button'
    )
    click(container.querySelector('[data-testid="new-session-launch"]'), 'Launch')

    expect(gridsOf()).toHaveLength(1)
  })
})
