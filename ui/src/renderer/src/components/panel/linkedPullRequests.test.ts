import { describe, expect, it } from 'vitest'
import type { PrInfo, SessionInfo } from '../../houston/client'
import { buildLinkedPullRequests, gridPrSources } from './linkedPullRequests'

function session(id: number, root?: string, checkoutRoot?: string): SessionInfo {
  return {
    id,
    checkout: root ? { root, kind: { worktree: { slug: 'test' } } } : null,
    checkout_root: checkoutRoot,
  } as SessionInfo
}

function pr(number: number): PrInfo {
  return {
    number,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: 'open',
    review_decision: null,
    checks: 'running',
    title: `PR ${number}`,
    head_ref: `branch-${number}`,
    additions: 3,
    deletions: 1,
    is_draft: false,
  }
}

describe('linked pull requests', () => {
  it('uses each distinct checkout root and deduplicates links by PR number', () => {
    const sessions = new Map([
      [1, session(1, '/repo/main')],
      [2, session(2, undefined, '/repo/main')],
      [3, session(3, '/repo/feature')],
    ])
    const sources = gridPrSources(
      sessions,
      [1, 2, 3],
      new Map([
        ['/repo/main', { pr: pr(42) }],
        ['/repo/feature', { pr: pr(42) }],
      ]),
    )

    expect(sources.map((source) => source.dir)).toEqual(['/repo/main', '/repo/feature'])
    expect(buildLinkedPullRequests(sources)).toHaveLength(1)
    expect(buildLinkedPullRequests(sources)[0]?.number).toBe(42)
  })

  it('returns no links when the active grid has no PRs', () => {
    const sessions = new Map([[1, session(1, '/repo')]])
    const sources = gridPrSources(sessions, [1], new Map())

    expect(buildLinkedPullRequests(sources)).toEqual([])
  })
})
