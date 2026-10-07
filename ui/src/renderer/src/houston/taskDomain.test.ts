import { describe, expect, it } from 'vitest'
import { isPullRequestUrl, linkIsPullRequest, type TaskTrackerLink } from './taskDomain'

describe('task domain UI rules', () => {
  it('recognizes only validated HTTPS pull request URLs', () => {
    expect(isPullRequestUrl('https://github.com/acme/repo/pull/42')).toBe(true)
    expect(isPullRequestUrl('https://github.com/acme/repo/issues/42')).toBe(false)
    expect(isPullRequestUrl('javascript:alert(1)')).toBe(false)
    expect(isPullRequestUrl('not a URL')).toBe(false)
  })

  it('does not treat a source tracker link as a pull request', () => {
    const link: TaskTrackerLink = {
      task_id: 1,
      provider: 'github_issues',
      external_id: '42',
      url: 'https://github.com/acme/repo/pull/42',
      source: 'source',
      fetched_at_ms: null,
      body_hash: null,
      remote_rev: null,
      synced_at_ms: null,
      snapshot: { base: {}, local: {}, remote: {}, conflicts: [], revision: 2, project_external_id: null, project: null },
      sync_state: { state: 'current' }
    }
    expect(linkIsPullRequest(link)).toBe(false)
    expect(linkIsPullRequest({ ...link, source: 'pull_request' })).toBe(true)
    expect(linkIsPullRequest({ ...link, provider: 'notion', source: 'pull_request' })).toBe(false)
    expect(linkIsPullRequest({ ...link, provider: 'slack', source: 'pull_request' })).toBe(false)
  })
})
