import { describe, expect, it } from 'vitest'
import { sortWorktreeCleanupRows, type WorktreeCleanupRow } from './worktreeCleanupRows'

const row = (path: string, state: WorktreeCleanupRow['state'], sizeBytes: number | null): WorktreeCleanupRow => ({
  path,
  branch: path,
  state,
  reason: '',
  sizeBytes,
  pr: null
})

describe('sortWorktreeCleanupRows', () => {
  it('groups Ready, Stale, then Kept and sorts each group by descending size', () => {
    expect(sortWorktreeCleanupRows([
      row('/kept-small', 'kept', 1),
      row('/stale-small', 'stale', 2),
      row('/ready-small', 'ready', 3),
      row('/ready-large', 'ready', 9),
      row('/stale-large', 'stale', 8),
      row('/kept-large', 'kept', 7)
    ]).map((item) => item.path)).toEqual([
      '/ready-large', '/ready-small', '/stale-large', '/stale-small', '/kept-large', '/kept-small'
    ])
  })
})
