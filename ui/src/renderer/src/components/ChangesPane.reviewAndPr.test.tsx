// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  click,
  file,
  mount,
  q,
  qa,
  teardown,
  typeCommitMessage,
  type Harness
} from './ChangesPane.harness'

vi.mock('../houston/bridge', () => ({
  saveReview: vi.fn(async () => '/tmp/review.md')
}))

afterEach(teardown)

function packet(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'git_review_diffs',
    dir: '/repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    head: 'abc123',
    files: [{ path: 'src/app.ts', status: 'modified', staged: true, is_sensitive: false }],
    sections: [{ scope: 'staged', patch: 'diff --git a/src/app.ts b/src/app.ts\n+x\n' }],
    blocked_paths: [],
    warnings: [],
    truncated: false,
    redacted: false,
    ...o
  }
}

function openPicker(): void {
  click(q('[data-testid="changes-review"]'))
}

function startReview(agent = 'claude'): void {
  openPicker()
  click(q(`[data-testid="review-provider-${agent}"]`))
  click(q('[data-testid="review-provider-start"]'))
}

describe('Changes pane — Review with agent', () => {
  it('the strip button opens the picker and asks for nothing yet', () => {
    const h = mount({})
    h.status([file()])
    openPicker()
    expect(q('[data-testid="review-provider-modal"]')).not.toBeNull()
    expect(h.client.gitReviewDiffsCalls).toEqual([])
  })

  it('offers every spawnable engine tile and no shell', () => {
    mount({})
    openPicker()
    expect(qa('[data-agent]')).toHaveLength(6)
    expect(qa('[data-agent] svg')).toHaveLength(6)
    expect(q('[data-testid="review-provider-shell"]')).toBeNull()
  })

  it('Start is refused until an engine is picked', () => {
    mount({})
    openPicker()
    expect(q<HTMLButtonElement>('[data-testid="review-provider-start"]')!.disabled).toBe(true)
    click(q('[data-testid="review-provider-codex"]'))
    expect(q<HTMLButtonElement>('[data-testid="review-provider-start"]')!.disabled).toBe(false)
  })

  it('Cancel closes the picker without sending anything', () => {
    const h = mount({})
    h.status([file()])
    openPicker()
    click(q('[data-testid="review-provider-codex"]'))
    click(q('[data-testid="review-provider-modal-close"]'))
    expect(q('[data-testid="review-provider-modal"]')).toBeNull()
    expect(h.client.gitReviewDiffsCalls).toEqual([])
  })

  it('picking an engine sends the request and the strip button goes busy', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    expect(h.client.gitReviewDiffsCalls).toEqual(['/repo'])
    expect(q('[data-testid="review-provider-modal"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-testid="changes-review"]')!.disabled).toBe(true)
  })

  it('the picked engine is the one that reviews', async () => {
    const h = mount({})
    h.status([file()])
    startReview('codex')
    await act(async () => {
      h.client.emit(packet() as never)
    })
    expect(h.client.createSessionCalls).toEqual([
      {
        agent: 'codex',
        project_dir: '/repo',
        prompt: 'Read-only pre-ship review. Read /tmp/review.md and follow it exactly.'
      }
    ])
  })

  it('a packet with no safe sections spawns NO session and says why', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    act(() => h.client.emit(packet({ sections: [] }) as never))
    expect(h.client.createSessionCalls).toHaveLength(0)
    expect(q('[data-testid="changes-review-error"]')!.textContent).toContain(
      'No safe diff content is available for review.'
    )
  })

  it('a reply for a repo the request was NOT made for is dropped', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    act(() => h.client.emit(packet({ dir: '/elsewhere' }) as never))
    expect(h.client.createSessionCalls).toHaveLength(0)
    expect(q('[data-testid="changes-review-notice"]')).toBeNull()
  })

  it('FIX 3: a capped/redacted packet is NAMED in the pane, blocked paths spelled out', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    act(() =>
      h.client.emit(
        packet({ truncated: true, redacted: true, blocked_paths: ['.env', 'deploy.key'] }) as never
      )
    )
    const notice = q('[data-testid="changes-review-notice"]')!
    expect(notice.textContent).toContain('capped')
    expect(notice.textContent).toContain('redacted')
    expect(notice.textContent).toContain('.env')
    expect(notice.textContent).toContain('deploy.key')
  })

  it('a clean packet shows no notice at all', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    act(() => h.client.emit(packet() as never))
    expect(q('[data-testid="changes-review-notice"]')).toBeNull()
  })

  it('a review failure clears the busy flag so the button recovers', () => {
    const h = mount({})
    h.status([file()])
    startReview()
    act(() => h.client.emit({ type: 'error', message: 'git review diffs task panicked' }))
    expect(q<HTMLButtonElement>('[data-testid="changes-review"]')!.disabled).toBe(false)
    expect(q('[data-testid="changes-review-error"]')!.textContent).toContain(
      'git review diffs task panicked'
    )
  })
})

describe('Changes pane — commit availability', () => {
  it('disables both Commit and its options when the message is empty', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    expect(q<HTMLButtonElement>('[data-testid="changes-commit"]')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-testid="changes-commit-options"]')!.disabled).toBe(true)
    click(q('[data-testid="changes-commit-options"]'))
    expect(q('[data-testid="changes-commit-push"]')).toBeNull()
  })

  it('an open options menu closes when the last staged file leaves', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    typeCommitMessage('msg')
    click(q('[data-testid="changes-commit-options"]'))
    expect(q('[data-testid="changes-commit-push"]')).not.toBeNull()
    h.status([file({ staged: false })])
    expect(q('[data-testid="changes-commit-push"]')).toBeNull()
  })
})

describe('Changes pane — the PR strip, three states', () => {
  function withPr(h: Harness, msg: Record<string, unknown>): void {
    act(() => h.client.emit({ type: 'pr_status', dir: '/repo', ...msg }))
  }

  it('no gh: one line with the fix, and no error state', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    withPr(h, {
      gh: 'unauthenticated',
      has_upstream: true,
      pr: null,
      hint: 'gh is not signed in — run `gh auth login`'
    })
    const line = q('[data-testid="changes-pr-blocked"]')!
    expect(line.textContent).toContain('gh auth login')
    expect(q('[data-testid="changes-pr-line"]')).toBeNull()
    expect(q('[data-testid="changes-pane"]')!.getAttribute('data-state')).toBe('filled')
  })

  it('no PR yet: the second commit button becomes Create PR', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    withPr(h, { gh: 'ready', has_upstream: true, pr: null, hint: null })
    expect(q('[data-testid="changes-create-pr"]')).not.toBeNull()
    expect(q('[data-testid="changes-commit-push"]')).toBeNull()
    click(q('[data-testid="changes-create-pr"]'))
    expect(h.client.prCreateCalls).toEqual(['/repo'])
  })

  it('no upstream: Commit & push stays, because that is what gets one', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    withPr(h, { gh: 'ready', has_upstream: false, pr: null, hint: null })
    expect(q('[data-testid="changes-create-pr"]')).toBeNull()
    typeCommitMessage('msg')
    click(q('[data-testid="changes-commit-options"]'))
    expect(q('[data-testid="changes-commit-push"]')).not.toBeNull()
  })

  it('a PR exists: one status line, and Open goes to a browser pane in this tab', () => {
    const onOpenUrl = vi.fn()
    const h = mount({ onOpenUrlInPane: onOpenUrl })
    h.status([file({ staged: true })])
    withPr(h, {
      gh: 'ready',
      has_upstream: true,
      hint: null,
      pr: {
        number: 212,
        url: 'https://github.com/o/r/pull/212',
        state: 'OPEN',
        review_decision: 'REVIEW_REQUIRED',
        checks: 'running'
      }
    })
    const line = q('[data-testid="changes-pr-line"]')!
    expect(line.textContent).toContain('PR #212')
    expect(line.textContent).toContain('checks running')
    expect(line.textContent).toContain('review requested')
    click(q('[data-testid="changes-pr-open"]'))
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/o/r/pull/212')
  })

  it('a failed create names gh\'s own reason rather than "PR creation failed"', () => {
    const h = mount({})
    h.status([file({ staged: true })])
    act(() =>
      h.client.emit({
        type: 'pr_create',
        dir: '/repo',
        gh: 'ready',
        pr: null,
        message: 'pull request create failed: GraphQL: No commits between main and feature'
      })
    )
    expect(q('[data-testid="changes-pr-message"]')!.textContent).toContain(
      'No commits between main and feature'
    )
  })
})

describe('Changes pane — the scope toggle', () => {
  it('starts on the working tree and asks for it with no base', () => {
    const h = mount({})
    h.status([file()])
    expect(h.client.gitStatusCalls[0]).toEqual({ dir: '/repo', base: null })
    expect(q('[data-testid="changes-scope-working"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('the branch option is labelled with the RESOLVED base', () => {
    const h = mount({})
    h.status([file()], { default_base: 'origin/develop' })
    expect(q('[data-testid="changes-scope-branch"]')!.textContent).toContain(
      'Branch vs origin/develop'
    )
  })

  it('with no base resolved the branch option is disabled rather than sending a doomed request', () => {
    const h = mount({})
    h.status([file()], { default_base: null })
    const branch = q<HTMLButtonElement>('[data-testid="changes-scope-branch"]')!
    expect(branch.textContent).toContain('Branch vs base')
    expect(branch.disabled).toBe(true)
  })

  it('switching to branch re-reads the status WITH the base', () => {
    const h = mount({})
    h.status([file()])
    click(q('[data-testid="changes-scope-branch"]'))
    expect(h.client.gitStatusCalls.at(-1)).toEqual({ dir: '/repo', base: 'main' })
  })

  it('a reply for the scope the pane has since left is dropped', () => {
    const h = mount({})
    h.status([file({ path: 'working-only.ts' })])
    click(q('[data-testid="changes-scope-branch"]'))
    act(() =>
      h.client.emit({
        type: 'git_status',
        dir: '/repo',
        files: [file({ path: 'stale.ts' })],
        branch: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        base: null,
        default_base: 'main'
      })
    )
    expect(q('[data-testid="changes-pane"]')!.getAttribute('data-state')).toBe('loading')
  })
})
