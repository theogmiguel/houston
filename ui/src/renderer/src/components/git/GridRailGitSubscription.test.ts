import { describe, expect, test } from 'vitest'
import { railGitDirs } from './GridRailGitSubscription'
import { buildRailCard } from '../rail/railCardModel'
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

describe('rail git keys', () => {
  const primarySub = session({
    id: 1, cwd: '/repo/sub', checkout_root: null,
    checkout: { root: '/repo', kind: 'primary', branch: 'main' },
  } as Partial<SessionInfo>)
  const worktree = session({
    id: 2, cwd: '/repo/.houston/worktrees/a/src', checkout_root: '/repo/.houston/worktrees/a',
    worktree: { path: '/repo/.houston/worktrees/a', branch: 'a', repo_common_dir: '/repo/.git' },
    checkout: { root: '/repo/.houston/worktrees/a', kind: { worktree: { slug: 'a' } } as never, branch: 'a' },
  } as Partial<SessionInfo>)

  test.each([['primary session in a subdirectory', primarySub, '/repo'], ['worktree session', worktree, '/repo/.houston/worktrees/a']])(
    'the fetched key matches the key the card reads: %s', (_name, info, root) => {
      const [fetched] = railGitDirs([info])
      expect(fetched).toBe(root)
      const diff = { added: 3, deleted: 1, ahead: 2 }
      const card = buildRailCard({ gridId: 'g', workspace: '/repo', title: 'G', paneIds: [info.id], sessions: [info], diffByDir: new Map([[fetched, diff]]) })
      expect(card.diff).toEqual(diff)
    })

  test('a primary grid and a worktree grid each show their own diff', () => {
    const facts = new Map([['/repo', { added: 1, deleted: 0, ahead: 0 }], ['/repo/.houston/worktrees/a', { added: 9, deleted: 4, ahead: 2 }]])
    const a = buildRailCard({ gridId: 'p', workspace: '/repo', title: 'P', paneIds: [1], sessions: [primarySub], diffByDir: facts })
    const b = buildRailCard({ gridId: 'w', workspace: '/repo', title: 'W', paneIds: [2], sessions: [worktree], diffByDir: facts })
    expect(a.diff).toEqual({ added: 1, deleted: 0, ahead: 0 })
    expect(b.diff).toEqual({ added: 9, deleted: 4, ahead: 2 })
  })
})
