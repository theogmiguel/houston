import { describe, expect, it } from 'vitest'
import type { ManagedWorktreeInfo } from '../../houston/generated/ManagedWorktreeInfo'
import { sortWorktreeCleanupRows, toWorktreeCleanupRow, type WorktreeCleanupRow } from './worktreeCleanupRows'

const row = (path: string, state: WorktreeCleanupRow['state'], sizeBytes: number | null): WorktreeCleanupRow => ({
  path,
  branch: path,
  baseBranch: null,
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

  it('maps backend cleanup status and stale idle details into the row model', () => {
    const entry = {
      path: '/stale',
      branch: 'feature/demo',
      base_branch: 'main',
      status: 'stale',
      keep: { kind: 'stale', idle_days: 20, removal_in_days: 10 },
      bytes: 2_000_000,
      pr: null
    } as unknown as ManagedWorktreeInfo

    expect(toWorktreeCleanupRow(entry, 0)).toEqual({
      path: '/stale',
      branch: 'feature/demo',
      baseBranch: 'main',
      state: 'stale',
      reason: 'Idle 20 days · removed in 10 days',
      sizeBytes: 2_000_000,
      pr: null
    })
  })

  it('uses the base branch to explain commits that are not integrated', () => {
    const entry = {
      path: '/kept',
      branch: 'feature/demo',
      base_branch: 'main',
      status: 'kept',
      keep: { kind: 'not_integrated' },
      bytes: null,
      pr: null
    } as unknown as ManagedWorktreeInfo

    expect(toWorktreeCleanupRow(entry, 0).reason).toBe('Kept: not integrated into main')
  })
})
