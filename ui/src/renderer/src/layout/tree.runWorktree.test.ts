import { describe, expect, it } from 'vitest'
import { DEFAULT_GRID_ID, gridStorageKey, preorderSessions, syncWorkspaceGrids, workspaceGridSessionIds, type LayoutState } from './tree'

const workspace = '/home/test/project'
const runTree = `${workspace}/.houston/worktrees/night-shift-1`
const grids = [{ id: DEFAULT_GRID_ID, name: 'Grid 1' }]
const key = gridStorageKey(workspace, DEFAULT_GRID_ID)
const empty = new Map<string, LayoutState>([[key, { tree: null, cols: 2 }]])

describe('panes started in a worktree of the workspace', () => {
  it('places a run orchestrator and its worker in the workspace grid, so Open can focus them', () => {
    const sessions = new Map([
      [74, { id: 74, project_dir: workspace, cwd: runTree }],
      [75, { id: 75, project_dir: workspace, cwd: runTree, spawned_by: 74 }],
    ])
    const ids = workspaceGridSessionIds(workspace, grids, empty, new Map(), sessions)
    expect(ids).toEqual([74, 75])
    const synced = syncWorkspaceGrids(workspace, grids, DEFAULT_GRID_ID, ids, empty)
    expect(preorderSessions(synced.get(key)?.tree ?? null).sort()).toEqual([74, 75])
  })

  it('does not adopt a pane whose project directory is the worktree itself', () => {
    const sessions = new Map([[74, { id: 74, project_dir: runTree }]])
    expect(workspaceGridSessionIds(workspace, grids, empty, new Map(), sessions)).toEqual([])
  })
})
