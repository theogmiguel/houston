import { describe, expect, test } from 'vitest'
import {
  shortSha,
  worktreeActionDisabledReason,
  worktreePathName,
  worktreeRemoveConfirm,
  worktreeRemoveLabel,
  worktreeSubtitle,
  worktreeTitle
} from './worktrees'
import type { GitWorktreeInfo } from '../../houston/generated/GitWorktreeInfo'

function wt(over: Partial<GitWorktreeInfo>): GitWorktreeInfo {
  return {
    path: '/home/dev/repo',
    branch: 'main',
    head: '1234567890abcdef',
    is_main: false,
    is_detached: false,
    is_bare: false,
    dirty: false,
    ...over
  }
}

describe('worktree labels', () => {
  test('a branch worktree shows the branch; detached shows a short sha', () => {
    expect(worktreeTitle(wt({ branch: 'houston/fix' }))).toBe('houston/fix')
    expect(
      worktreeTitle(wt({ branch: null, is_detached: true, head: '1234567890abcdef' }))
    ).toBe('detached @ 1234567')
    expect(shortSha(null)).toBe('')
  })

  test('the subtitle names the path, the main checkout and dirt', () => {
    const s = worktreeSubtitle(wt({ path: '/w/task', is_main: true, dirty: true }))
    expect(s).toContain('/w/task')
    expect(s).toContain('main checkout')
    expect(s).toContain('uncommitted changes')
  })

  test('only the main checkout and bare repos are refused', () => {
    expect(worktreeActionDisabledReason(wt({ is_main: true }))).toContain('main checkout')
    expect(worktreeActionDisabledReason(wt({ is_bare: true }))).toContain('bare')
    expect(worktreeActionDisabledReason(wt({ branch: 'x' }))).toBeNull()
  })

  test('the force confirm says what is lost and what is kept', () => {
    const confirm = worktreeRemoveConfirm(wt({ branch: 'houston/x', path: '/w/x' }), true)
    expect(confirm).toContain('Force-remove')
    expect(confirm).toContain('Uncommitted changes there are lost')
    expect(confirm).toContain('branch itself is kept')
    expect(worktreeRemoveConfirm(wt({ branch: 'houston/x', path: '/w/x' }), false)).not.toContain(
      'Force-remove'
    )
    expect(worktreeRemoveLabel(true)).toBe('Force remove')
    expect(worktreeRemoveLabel(false)).toBe('Remove worktree')
  })

  test('the path tail names a worktree when it has no branch', () => {
    expect(worktreePathName('/home/dev/wt/task/')).toBe('task')
  })
})
