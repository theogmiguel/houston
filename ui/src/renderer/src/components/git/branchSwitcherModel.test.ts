import { describe, expect, it } from 'vitest'
import { recentBranches, branchAgeLabel, branchMetaLabel, branchSyncLabel, worktreeSlug } from './branchSwitcherModel'

describe('worktree names', () => {
  it('matches the daemon normalization so the visible branch matches the reply', () => {
    expect(worktreeSlug('feat/agents-overview')).toBe('feat-agents-overview')
    expect(worktreeSlug('---Feature_One---')).toBe('feature_one')
    expect(worktreeSlug('é/')).toBe('x')
    expect(worktreeSlug('a'.repeat(80))).toBe('a'.repeat(60))
  })
})


describe('branch presentation', () => {
  it('formats commit ages and leaves unknown ages out of default metadata', () => {
    const now = 1_800_000_000_000
    expect(branchAgeLabel(undefined, now)).toBeNull()
    expect(branchAgeLabel(now / 1000 + 60, now)).toBe('now')
    expect(branchAgeLabel(now / 1000 - 300, now)).toBe('5m')
    expect(branchAgeLabel(now / 1000 - 10800, now)).toBe('3h')
    expect(branchAgeLabel(now / 1000 - 172800, now)).toBe('2d')
    expect(branchMetaLabel({ name: 'main', current: false, is_default: true, is_remote: false, behind: 2 })).toBe('default · 2 behind')
  })

  it('pins current then sorts by commit time including default and worktrees', () => {
    const branches = [
      { name: 'main', is_default: true, committed_at: 1 },
      { name: 'tree', worktree_path: '/tree', committed_at: 30 },
      { name: 'topic', current: true, committed_at: 2 },
      { name: 'recent', committed_at: 20 }
    ].map((item) => ({ current: false, is_default: false, is_remote: false, ...item }))
    expect(recentBranches(branches).map((item) => item.name)).toEqual(['topic', 'tree', 'recent', 'main'])
    expect(branches[0].name).toBe('main')
  })

  it('shows divergence counts without zero counts', () => {
    const branch = { name: 'topic', current: false, is_default: false, is_remote: false }
    expect(branchSyncLabel({ ...branch, ahead: 1, behind: 2 })).toBe('1 ahead · 2 behind')
    expect(branchSyncLabel({ ...branch, ahead: 0, behind: 0 })).toBeNull()
  })
})
