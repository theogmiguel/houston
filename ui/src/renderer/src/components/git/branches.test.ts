import { describe, expect, test } from 'vitest'
import {
  branchNote,
  branchTitle,
  deleteBranchDisabledReason,
  filterBranches,
  nameShapeLooksValid,
  renameTargetLooksValid,
  sortBranches,
  switchBranchDisabledReason,
  BRANCH_MENU_LIMIT
} from './branches'
import type { GitBranchInfo } from '../../houston/generated/GitBranchInfo'

function branch(over: Partial<GitBranchInfo>): GitBranchInfo {
  return {
    name: 'main',
    current: false,
    is_default: false,
    is_remote: false,
    remote_name: null,
    upstream: null,
    worktree_path: null,
    ...over
  }
}

describe('branch rows', () => {
  test('a remote branch shows the short name with the full ref as its note', () => {
    const b = branch({ name: 'origin/feat/x', is_remote: true, remote_name: 'origin' })
    expect(branchTitle(b)).toBe('feat/x')
    expect(branchNote(b)).toContain('origin/feat/x')
  })

  test('a local branch with its upstream and worktree explains both', () => {
    const b = branch({
      name: 'task/wt',
      upstream: 'origin/task/wt',
      worktree_path: '/home/dev/wt',
      is_default: true
    })
    const note = branchNote(b)
    expect(note).toContain('tracks origin/task/wt')
    expect(note).toContain('checked out at /home/dev/wt')
    expect(note).toContain('default')
  })

  test('a plain branch has no note', () => {
    expect(branchNote(branch({ name: 'feature' }))).toBeNull()
  })
})

describe('filtering and sorting', () => {
  test('a query matches case-insensitively and keeps daemon order otherwise', () => {
    const rows = filterBranches(
      [branch({ name: 'main' }), branch({ name: 'feature/login' }), branch({ name: 'fix' })],
      'LOGIN'
    )
    expect(rows.map((r) => r.branch.name)).toEqual(['feature/login'])
    expect(filterBranches([branch({ name: 'main' })], '  ').length).toBe(1)
  })

  test('the cap holds even when everything matches', () => {
    const many = Array.from({ length: BRANCH_MENU_LIMIT + 25 }, (_, i) =>
      branch({ name: `b${i}` })
    )
    expect(filterBranches(many, '').length).toBe(BRANCH_MENU_LIMIT)
  })

  test('sort puts the current branch first, then the default, then locals and remotes', () => {
    const sorted = sortBranches([
      branch({ name: 'origin/main', is_remote: true, remote_name: 'origin' }),
      branch({ name: 'zzz' }),
      branch({ name: 'main', is_default: true }),
      branch({ name: 'aaa', current: true })
    ]).map((b) => b.name)
    expect(sorted).toEqual(['aaa', 'main', 'zzz', 'origin/main'])
  })
})

describe('refusals the menu can show before asking the daemon', () => {
  test('switching to the current branch is refused with a reason', () => {
    expect(switchBranchDisabledReason(branch({ current: true }))).toContain('already checked out')
    expect(switchBranchDisabledReason(branch({ name: 'x' }))).toBeNull()
  })

  test('deleting is refused for current, worktree, remote and last branches', () => {
    expect(deleteBranchDisabledReason(branch({ current: true }), 3)).toContain('checked-out')
    expect(
      deleteBranchDisabledReason(branch({ worktree_path: '/w' }), 3)
    ).toContain('remove that worktree first')
    expect(deleteBranchDisabledReason(branch({ is_remote: true }), 3)).toContain('Remote branches')
    expect(deleteBranchDisabledReason(branch({ name: 'only' }), 1)).toContain('last branch')
    expect(deleteBranchDisabledReason(branch({ name: 'fine' }), 2)).toBeNull()
  })

  test('name shape gates the create and rename buttons', () => {
    expect(nameShapeLooksValid('feat/x')).toBe(true)
    expect(nameShapeLooksValid('  feat/x ')).toBe(true)
    expect(nameShapeLooksValid('')).toBe(false)
    expect(nameShapeLooksValid('   ')).toBe(false)
    expect(nameShapeLooksValid('-flag')).toBe(false)
    expect(nameShapeLooksValid('two words')).toBe(false)

    expect(renameTargetLooksValid('old', 'new')).toBe(true)
    expect(renameTargetLooksValid('old', 'old')).toBe(false)
    expect(renameTargetLooksValid('old', '-x')).toBe(false)
  })
})
