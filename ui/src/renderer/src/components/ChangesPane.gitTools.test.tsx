// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, click, file, mount, q, qa, teardown } from './ChangesPane.harness'

afterEach(teardown)

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Changes pane — git tools', () => {
  it('the menu opens Branches and the dialog drives create/switch/delete through the client', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])

    click(q('[data-testid="git-tools-menu"]'))
    click(q('[data-testid="git-tools-branches"]'))
    expect(h.client.gitBranchesCalls).toEqual(['/repo'])

    act(() => {
      h.client.emit({
        type: 'git_branches',
        dir: '/repo',
        branches: [
          {
            name: 'main',
            current: true,
            is_default: true,
            is_remote: false,
            remote_name: null,
            upstream: 'origin/main',
            worktree_path: '/repo'
          },
          {
            name: 'feat/x',
            current: false,
            is_default: false,
            is_remote: false,
            remote_name: null,
            upstream: null,
            worktree_path: null
          }
        ],
        remotes: [],
        default_branch: 'main',
        truncated: false
      })
    })
    // The dialog lists what the daemon sent, current first.
    expect(qa('[data-testid="branch-row"]').map((r) => r.getAttribute('data-branch'))).toEqual([
      'main',
      'feat/x'
    ])

    type(q<HTMLInputElement>('[data-testid="branch-new-name"]')!, 'feat/new')
    click(q('[data-testid="branch-new-create"]'))
    expect(h.client.gitBranchCreateCalls).toEqual([
      { dir: '/repo', name: 'feat/new', base: null, switchTo: true }
    ])
    // The daemon pushes the fresh listing after a mutation; busy clears with it.
    act(() => {
      h.client.emit({
        type: 'git_branches',
        dir: '/repo',
        branches: [
          {
            name: 'main',
            current: true,
            is_default: true,
            is_remote: false,
            remote_name: null,
            upstream: 'origin/main',
            worktree_path: '/repo'
          },
          {
            name: 'feat/new',
            current: false,
            is_default: false,
            is_remote: false,
            remote_name: null,
            upstream: null,
            worktree_path: null
          }
        ],
        remotes: [],
        default_branch: 'main',
        truncated: false
      })
    })

    click(qa('[data-testid="branch-select"]')[1])
    expect(h.client.gitBranchSwitchCalls).toEqual([{ dir: '/repo', name: 'feat/new' }])
    act(() => {
      h.client.emit({
        type: 'git_branches',
        dir: '/repo',
        branches: [
          {
            name: 'main',
            current: true,
            is_default: true,
            is_remote: false,
            remote_name: null,
            upstream: 'origin/main',
            worktree_path: '/repo'
          },
          {
            name: 'feat/new',
            current: false,
            is_default: false,
            is_remote: false,
            remote_name: null,
            upstream: null,
            worktree_path: null
          }
        ],
        remotes: [],
        default_branch: 'main',
        truncated: false
      })
    })

    click(qa('[data-testid="branch-delete"]')[1])
    click(q('[data-testid="branch-delete-safe"]'))
    click(qa('button').filter((b) => b.textContent === 'Delete').at(-1)!)
    expect(h.client.gitBranchDeleteCalls).toEqual([{ dir: '/repo', name: 'feat/new', force: false }])
  })

  it('worktrees and checkpoints load on open and keep the daemon as the source', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])

    click(q('[data-testid="git-tools-menu"]'))
    click(q('[data-testid="git-tools-worktrees"]'))
    expect(h.client.gitWorktreesCalls).toEqual(['/repo'])
    act(() => {
      h.client.emit({
        type: 'git_worktrees',
        dir: '/repo',
        worktrees: [
          {
            path: '/repo',
            branch: 'main',
            head: 'abcdef1234567890',
            is_main: true,
            is_detached: false,
            is_bare: false,
            dirty: false
          }
        ],
        message: null
      })
    })
    expect(qa('[data-testid="worktree-row"]').length).toBe(1)
    click(q('[data-testid="worktrees-prune"]'))
    expect(h.client.gitWorktreePruneCalls).toEqual(['/repo'])

    click(q('[data-testid="git-worktrees-dialog-close"]'))
    click(q('[data-testid="git-tools-menu"]'))
    click(q('[data-testid="git-tools-checkpoints"]'))
    expect(h.client.gitCheckpointsCalls).toEqual(['/repo'])
    act(() => {
      h.client.emit({
        type: 'git_checkpoints',
        dir: '/repo',
        owner: null,
        checkpoints: [
          {
            ref: 'refs/houston/checkpoints/xbWFudWFs/xYmFzZQ',
            label: 'base',
            owner: 'manual',
            sha: '1234567890abcdef',
            created_ms: Date.now() - 1000
          }
        ]
      })
    })
    click(q('[data-testid="checkpoint-inspect"]'))
    expect(h.client.gitCheckpointDiffCalls).toEqual([
      { dir: '/repo', ref: 'refs/houston/checkpoints/xbWFudWFs/xYmFzZQ', against: 'working' }
    ])
  })

  it('Pull appears only when the branch is behind and asks the daemon to pull', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })], { behind: 0 })
    expect(q('[data-testid="changes-pull"]')).toBeNull()

    h.status([file({ path: 'src/app.ts' })], { behind: 2 })
    click(q('[data-testid="changes-pull"]'))
    expect(h.client.gitPullCalls).toEqual(['/repo'])
  })

  it('generate-commit fills the editable commit input from the reply', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts', staged: true })])

    click(q('[data-testid="changes-generate-commit"]'))
    expect(h.client.gitCommitMessageCalls).toEqual(['/repo'])

    act(() => {
      h.client.emit({
        type: 'git_commit_message',
        dir: '/repo',
        message: 'fix(git): keep the receipt',
        error: null
      })
    })
    expect(q<HTMLInputElement>('[data-testid="changes-commit-message"]')!.value).toBe(
      'fix(git): keep the receipt'
    )
  })

  it('Write PR with AI previews the generated text before any gh call', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    act(() => {
      h.client.emit({
        type: 'pr_status',
        dir: '/repo',
        gh: 'ready',
        has_upstream: true,
        pr: null,
        hint: null
      })
    })

    click(q('[data-testid="changes-create-pr-ai"]'))
    expect(q('[data-testid="pr-compose-modal"]')).not.toBeNull()
    expect(h.client.prComposeCalls).toEqual([])

    click(q('[data-testid="pr-compose-generate"]'))
    expect(h.client.gitPrContentCalls).toEqual(['/repo'])
    act(() => {
      h.client.emit({
        type: 'git_pr_content',
        dir: '/repo',
        title: 'Add staging',
        body: 'Why it helps.',
        error: null
      })
    })
    expect(q<HTMLInputElement>('[data-testid="pr-compose-title-input"]')!.value).toBe('Add staging')

    type(q<HTMLTextAreaElement>('[data-testid="pr-compose-body-input"]')!, 'Edited body.')
    click(q('[data-testid="pr-compose-create"]'))
    expect(h.client.prComposeCalls).toEqual([
      { dir: '/repo', title: 'Add staging', body: 'Edited body.' }
    ])

    act(() => {
      h.client.emit({
        type: 'pr_create',
        dir: '/repo',
        gh: 'ready',
        pr: null,
        message: 'gh refused: no commits between main and HEAD'
      })
    })
    expect(q('[data-testid="pr-compose-error"]')?.textContent).toContain('gh refused')
    expect(q('[data-testid="pr-compose-modal"]')).not.toBeNull()
  })
})
