// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRID_ID, type GridMeta } from './layout/tree'
import type { TagInfo } from './houston/generated/TagInfo'
import {
  type AppHarness,
  currentClient,
  deliverControl,
  makeSession,
  makeWorkspace,
  renderReadyApp,
  resetHarness
} from './test/appTestHarness'

const WS = '/tmp/project'
const TAGS: TagInfo[] = [
  { id: 1, name: 'code review', color: '#a78bfa' },
  { id: 2, name: 'wait-human', color: '#f59e0b' }
]

const storedGrids = (): GridMeta[] => JSON.parse(localStorage.getItem(`tr-grids:${WS}`) ?? '[]')

beforeEach(() => {
  resetHarness()
  localStorage.clear()
})

describe('grid tags stand apart from pane tags', () => {
  let harness: AppHarness | null = null

  afterEach(() => {
    harness?.unmount()
    harness = null
  })

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
    })
  }

  const gridChipNames = (): string[] =>
    [...harness!.container.querySelectorAll('[data-testid="grid-row"] [data-testid="tag-chip"]')].map(
      (c) => c.textContent ?? ''
    )

  it('a grid saved before grids had tags takes its panes’ tags once, and the panes are cleared', async () => {
    localStorage.setItem(`tr-grids:${WS}`, JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1' }]))
    harness = await renderReadyApp({
      tags: TAGS,
      sessions: [
        makeSession({ id: 1, project_dir: WS, cwd: WS, tags: [1] }),
        makeSession({ id: 2, project_dir: WS, cwd: WS, tags: [1, 2] }),
        makeSession({ id: 3, project_dir: WS, cwd: WS, tags: [] })
      ],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await settle()

    expect(storedGrids()[0].tags).toEqual([1, 2])
    const setSessionTags = vi.mocked(currentClient().setSessionTags)
    expect(setSessionTags.mock.calls).toEqual([
      [1, []],
      [2, []]
    ])
    expect(gridChipNames()[0]).toContain('code review')
  })

  it('a grid with its own tag list is never migrated, and a pane tag stays on the pane', async () => {
    localStorage.setItem(
      `tr-grids:${WS}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1', tags: [] }])
    )
    harness = await renderReadyApp({
      tags: TAGS,
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS, tags: [2] })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await settle()

    expect(vi.mocked(currentClient().setSessionTags)).not.toHaveBeenCalled()
    expect(storedGrids()[0].tags).toEqual([])
    expect(gridChipNames()).toEqual([])
    const paneChip = harness.container.querySelector('.pane header [data-testid="tag-chip"]')
    expect(paneChip?.textContent).toContain('wait-human')
  })

  it('a deleted tag leaves the grids that carried it', async () => {
    localStorage.setItem(
      `tr-grids:${WS}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1', tags: [1, 2] }])
    )
    harness = await renderReadyApp({
      tags: TAGS,
      sessions: [makeSession({ id: 1, project_dir: WS, cwd: WS, tags: [] })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await settle()

    deliverControl({ type: 'tag_deleted', tag: 1 })
    await settle()
    expect(storedGrids()[0].tags).toEqual([2])
    expect(gridChipNames()[0]).toContain('wait-human')
  })

  it('an authoritative hello removes deleted ids from saved and closed-workspace grids', async () => {
    const orphanWorkspace = '/tmp/closed-workspace'
    localStorage.setItem(
      `tr-grids:${WS}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1', tags: [1] }])
    )
    localStorage.setItem(
      `tr-grids:${orphanWorkspace}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1', tags: [1] }])
    )
    harness = await renderReadyApp({
      tags: [],
      sessions: [makeSession({ project_dir: WS, cwd: WS })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await settle()

    expect(storedGrids()[0].tags).toEqual([])
    expect(JSON.parse(localStorage.getItem(`tr-grids:${orphanWorkspace}`) ?? '[]')[0].tags).toEqual([])

    deliverControl({ type: 'tag_list', tags: [{ id: 2, name: 'new tag', color: '#34d399' }] })
    await settle()
    expect(storedGrids()[0].tags).toEqual([])
    expect(gridChipNames()).toEqual([])
  })

  it('an authoritative tag list removes ids deleted after hello and preserves remaining grid tags', async () => {
    localStorage.setItem(
      `tr-grids:${WS}`,
      JSON.stringify([{ id: DEFAULT_GRID_ID, name: 'Grid 1', tags: [1, 2] }])
    )
    harness = await renderReadyApp({
      tags: TAGS,
      sessions: [makeSession({ project_dir: WS, cwd: WS, tags: [] })],
      workspaces: [makeWorkspace({ path: WS })]
    })
    await settle()

    deliverControl({ type: 'tag_list', tags: [TAGS[1]] })
    await settle()
    expect(storedGrids()[0].tags).toEqual([2])
    expect(gridChipNames()[0]).toContain('wait-human')
  })
})
