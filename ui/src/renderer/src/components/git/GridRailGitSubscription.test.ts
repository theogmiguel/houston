import { describe, expect, test } from 'vitest'
import { railGitDirs } from './GridRailGitSubscription'
import type { SessionInfo } from '../../houston/client'

function session(fields: Partial<SessionInfo>): SessionInfo {
  return { agent: 'claude', state: 'running', cwd: '/repo', worktree: null, checkout_root: null, ...fields } as SessionInfo
}

describe('railGitDirs', () => {
  test('skips ended sessions whose worktree may already be removed', () => {
    const dirs = railGitDirs([
      session({ cwd: '/repo' }),
      session({ state: 'exited', cwd: '/repo/.houston/worktrees/gone' }),
      session({ state: 'killed', cwd: '/repo/.houston/worktrees/killed' }),
      session({ state: 'interrupted', cwd: '/repo/.houston/worktrees/interrupted' }),
    ])
    expect(dirs).toEqual(['/repo'])
  })

  test('prefers the worktree, then the checkout root, and skips ssh sessions', () => {
    const dirs = railGitDirs([
      session({ cwd: '/repo/sub', worktree: { path: '/repo/.houston/worktrees/a' } as SessionInfo['worktree'] }),
      session({ cwd: '/other/sub', checkout_root: '/other' }),
      session({ agent: 'ssh', cwd: '/remote' }),
    ])
    expect(dirs).toEqual(['/repo/.houston/worktrees/a', '/other'])
  })
})
