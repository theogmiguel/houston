import { describe, expect, it } from 'vitest'
import { worktreeSlug } from './branchSwitcherModel'

describe('worktree names', () => {
  it('matches the daemon normalization so the visible branch matches the reply', () => {
    expect(worktreeSlug('feat/agents-overview')).toBe('feat-agents-overview')
    expect(worktreeSlug('---Feature_One---')).toBe('feature_one')
    expect(worktreeSlug('é/')).toBe('x')
    expect(worktreeSlug('a'.repeat(80))).toBe('a'.repeat(60))
  })
})
