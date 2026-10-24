// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, preorderSessions } from './layout/tree'
import {
  type AppHarness,
  currentClient,
  deliverClientMsg,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const FROM = '/tmp/project'
const TO = '/tmp/project-moved'

vi.mock('./houston/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./houston/bridge')>()),
  pickDirectories: vi.fn(async () => [TO])
}))

function savedLayout(path: string, grid: string): { tree: unknown; cols: number } | null {
  return JSON.parse(localStorage.getItem(`tr-layout:${gridStorageKey(path, grid)}`) ?? 'null')
}

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('a relocated workspace keeps its grids', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  it('carries every grid and pane arrangement to the new path in the daemon order', async () => {
    const split = {
      kind: 'split',
      dir: 'row',
      weights: [70, 30],
      children: [
        { kind: 'leaf', session: 1, id: 'pane-one' },
        { kind: 'leaf', session: 3, id: 'pane-three' }
      ]
    }
    localStorage.setItem(
      `tr-grids:${FROM}`,
      JSON.stringify([
        { id: DEFAULT_GRID_ID, name: 'Terminal', nameSource: 'auto', tags: [] },
        { id: 'g-web', name: 'Web', nameSource: 'user', tags: [] }
      ])
    )
    localStorage.setItem(`tr-layout:${gridStorageKey(FROM, DEFAULT_GRID_ID)}`, JSON.stringify({ tree: split, cols: 2 }))
    localStorage.setItem(
      `tr-layout:${gridStorageKey(FROM, 'g-web')}`,
      JSON.stringify({ tree: { kind: 'leaf', session: 2, id: 'pane-two' }, cols: 2 })
    )
    harness = await renderReadyApp({
      sessions: [1, 2, 3].map((id) => makeSession({ id, project_dir: FROM, cwd: FROM })),
      workspaces: [makeWorkspace({ path: FROM, name: 'project', missing: true })]
    })
    expect(savedLayout(FROM, DEFAULT_GRID_ID)?.tree).toMatchObject(split)

    const client = currentClient() as unknown as { relocateWorkspace: ReturnType<typeof vi.fn> }
    client.relocateWorkspace = vi.fn()
    const row = [...harness.container.querySelectorAll<HTMLElement>('.witem[role="button"]')].find((el) =>
      el.textContent?.includes('project')
    )!
    await act(async () => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 90 }))
      await Promise.resolve()
    })
    act(() => document.querySelector<HTMLElement>('[data-testid="ws-locate-moved"]')!.click())
    await vi.waitFor(() => expect(client.relocateWorkspace).toHaveBeenCalledWith(FROM, TO))
    // As the client dispatches: kind subscribers, then the rest; each frame is its own task.
    const deliver = async (msg: Parameters<typeof deliverControl>[0]): Promise<void> => {
      deliverClientMsg(msg.type, msg)
      deliverControl(msg)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    await deliver({
      type: 'workspace_relocated',
      from: FROM,
      to: TO,
      moved: { worktrees: 0, sessions: 3, repaired: 0, notes: [] }
    })
    for (const session of [1, 2, 3]) await deliver({ type: 'session_reparented', session, project_dir: TO })
    await deliver({ type: 'workspace_list', workspaces: [makeWorkspace({ path: TO, name: 'project-moved' })] })
    await vi.waitFor(() => expect(document.body.textContent).toContain(`Workspace now at ${TO}`))

    const grids = JSON.parse(localStorage.getItem(`tr-grids:${TO}`) ?? '[]') as { id: string }[]
    expect(grids.map((g) => g.id)).toEqual([DEFAULT_GRID_ID, 'g-web'])
    expect(savedLayout(TO, DEFAULT_GRID_ID)?.tree).toMatchObject(split)
    expect(preorderSessions(savedLayout(TO, 'g-web')?.tree as never)).toEqual([2])
    expect(localStorage.getItem(`tr-layout:${gridStorageKey(FROM, 'g-web')}`)).toBeNull()
    expect(harness.container.querySelector('[data-testid="grid-row"][data-selected="true"]')?.textContent).toContain('Terminal')
  })
})
