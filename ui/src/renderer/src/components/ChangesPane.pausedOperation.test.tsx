// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { click, file, mount, q, teardown } from './ChangesPane.harness'

afterEach(teardown)

describe('Changes pane — paused merge, rebase or cherry-pick', () => {
  it('shows no banner while nothing is paused', () => {
    const h = mount({})
    h.status([file()])
    expect(q('[data-testid="changes-paused-operation"]')).toBeNull()
  })

  it('names the operation and its conflicts, and Resolve with agent spawns a briefed pane in the checkout', () => {
    const h = mount({})
    h.status([file({ path: 'src/a.ts', status: 'conflicted' }), file({ path: 'README.md' })], { operation: 'rebase', branch: 'feature' })
    expect(q('[data-testid="changes-paused-operation"]')!.textContent).toContain('A rebase is paused here with 1 conflicted file.')

    click(q('[data-testid="changes-resolve-with-agent"]'))
    expect(q('[data-testid="review-provider-modal"]')!.textContent).toContain('Resolve the paused rebase')
    click(q('[data-testid="review-provider-codex"]'))
    click(q('[data-testid="review-provider-start"]'))

    expect(h.client.createSessionCalls).toHaveLength(1)
    const call = h.client.createSessionCalls[0] as { agent: string; project_dir: string; prompt: string }
    expect(call.agent).toBe('codex')
    expect(call.project_dir).toBe('/repo')
    expect(call.prompt).toContain('A git rebase is paused in /repo (branch feature).')
    expect(call.prompt).toContain('- src/a.ts')
    expect(call.prompt).not.toContain('- README.md')
    expect(call.prompt).toContain('git diff --check')
    expect(call.prompt).toContain('Never run `git reset --hard`, `git checkout -- <path>`, `git restore`, `git clean`, `git stash` or `git rebase --abort`')
    expect(call.prompt).toContain('Report back:')
    expect(h.client.gitReviewDiffsCalls).toEqual([])
  })

  it('the banner leaves once the status no longer reports the operation', () => {
    const h = mount({})
    h.status([], { operation: 'merge' })
    expect(q('[data-testid="changes-paused-operation"]')!.textContent).toContain('A merge is paused here.')
    h.status([])
    expect(q('[data-testid="changes-paused-operation"]')).toBeNull()
  })
})
