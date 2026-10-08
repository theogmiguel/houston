import { describe, expect, it } from 'vitest'
import type { PrListItem } from '../../houston/client'
import { filterPullRequests, groupPullRequests, sortPullRequests } from './prListModel'

function item(overrides: Partial<PrListItem> & Pick<PrListItem, 'number' | 'author' | 'title'>): PrListItem {
  return {
    url: `https://github.com/acme/repo/pull/${overrides.number}`,
    state: 'open',
    is_draft: false,
    head_ref: 'feature',
    base_ref: 'main',
    updated_at: 100,
    created_at: 50,
    additions: 3,
    deletions: 1,
    review_decision: null,
    checks: 'passing',
    labels: [],
    comments: 0,
    review_requested: false,
    mergeable: 'mergeable',
    ...overrides,
  }
}

describe('pull request list model', () => {
  it('groups authored, review requested, and other requests after sorting each group', () => {
    const items = [
      item({ number: 1, title: 'First', author: 'Theo', updated_at: 100 }),
      item({ number: 2, title: 'Second', author: 'reviewer', review_requested: true, updated_at: 300 }),
      item({ number: 3, title: 'Third', author: 'someone', updated_at: 200 }),
    ]
    const groups = groupPullRequests(items, 'theo', 'updated')
    expect(groups.authored.map((pr) => pr.number)).toEqual([1])
    expect(groups.reviewRequested.map((pr) => pr.number)).toEqual([2])
    expect(groups.others.map((pr) => pr.number)).toEqual([3])
    expect(sortPullRequests(items, 'created').map((pr) => pr.number)).toEqual([1, 2, 3])
  })

  it('ranks Ready first and treats a number search as an exact lookup', () => {
    const items = [
      item({ number: 12, title: 'Fix title', author: 'a', mergeable: 'unknown' }),
      item({ number: 123, title: 'Fix another', author: 'b', mergeable: 'mergeable' }),
    ]
    expect(sortPullRequests(items, 'ready').map((pr) => pr.number)).toEqual([123, 12])
    expect(filterPullRequests(items, '#12').map((pr) => pr.number)).toEqual([12])
  })
})
