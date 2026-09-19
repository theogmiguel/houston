// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, click, file, mount, q, qa, teardown } from './ChangesPane.harness'

afterEach(teardown)

function menu(): HTMLButtonElement[] {
  return qa<HTMLButtonElement>('[role="menuitem"]')
}

function typeCommitMessage(value: string): void {
  const input = q<HTMLTextAreaElement>('[data-testid="changes-commit-message"]')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Changes pane — stage / unstage', () => {
  it('the row menu stages an unstaged file against the repo root', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    expect(menu()[0].textContent).toBe('Stage')
    click(menu()[0])
    expect(h.client.gitStageCalls).toEqual([{ dir: '/repo', paths: ['src/app.ts'] }])
  })

  it('the row menu unstages a staged file', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts', staged: true })])
    click(q('[data-testid="changes-row-menu"]'))
    expect(menu()[0].textContent).toBe('Unstage')
    click(menu()[0])
    expect(h.client.gitUnstageCalls).toEqual([{ dir: '/repo', paths: ['src/app.ts'] }])
  })

  it('`s` toggles the selected row without opening a menu', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-file"]'))
    act(() => {
      q('[data-testid="changes-list"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', bubbles: true })
      )
    })
    expect(h.client.gitStageCalls).toEqual([{ dir: '/repo', paths: ['src/app.ts'] }])
  })
})

describe('Changes pane — keyboard', () => {
  it('↑/↓ move the selection and Enter opens the diff', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts' }), file({ path: 'b.ts' })])
    const list = q('[data-testid="changes-list"]')!
    const key = (k: string): void => {
      act(() => list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    }
    key('ArrowDown')
    expect(q('[data-testid="changes-file"]')!.getAttribute('aria-selected')).toBe('true')
    key('ArrowDown')
    expect(qa('[data-testid="changes-file"]')[1].getAttribute('aria-selected')).toBe('true')
    key('ArrowUp')
    expect(q('[data-testid="changes-file"]')!.getAttribute('aria-selected')).toBe('true')
    key('Enter')
    expect(h.client.gitDiffCalls.at(-1)).toEqual({ dir: '/repo', path: 'a.ts', base: null })
  })
})

describe('Changes pane — discard', () => {
  it('a tracked discard confirms, names the file, and only then sends', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    click(menu()[1])
    expect(h.client.gitDiscardCalls).toHaveLength(0)
    const modal = document.body.textContent ?? ''
    expect(modal).toContain('src/app.ts')
    const confirm = qa<HTMLButtonElement>('button').find(
      (b) => b.textContent === 'Discard changes' && b.getAttribute('role') !== 'menuitem'
    )!
    click(confirm)
    expect(h.client.gitDiscardCalls).toEqual([
      { dir: '/repo', path: 'src/app.ts', kind: 'unstaged' }
    ])
  })

  it('an untracked discard is worded, labelled and SENT as a delete', () => {
    const h = mount({})
    h.status([file({ path: 'scratch.txt', status: 'untracked' })])
    click(q('[data-testid="changes-row-menu"]'))
    expect(menu()[1].textContent).toBe('Delete file')
    click(menu()[1])
    expect(document.body.textContent).toContain('Delete scratch.txt')
    const confirm = qa<HTMLButtonElement>('button').find(
      (b) => b.textContent === 'Delete file' && b.getAttribute('role') !== 'menuitem'
    )!
    click(confirm)
    expect(h.client.gitDiscardCalls).toEqual([
      { dir: '/repo', path: 'scratch.txt', kind: 'untracked' }
    ])
  })

  it('cancelling the confirm sends nothing', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    click(menu()[1])
    const cancel = qa<HTMLButtonElement>('button').find((b) => b.textContent === 'Cancel')!
    click(cancel)
    expect(h.client.gitDiscardCalls).toHaveLength(0)
  })
})

describe('Changes pane — open in editor (carried from GitPanel.openInEditor.test.tsx)', () => {
  it('calls back with the repo root and the file path joined absolute', () => {
    const onOpen = vi.fn()
    const h = mount({ onOpenFileInEditor: onOpen })
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    click(menu()[2])
    expect(onOpen).toHaveBeenCalledWith('/repo/src/app.ts')
  })

  it('opening in the editor does not also select the row (no diff side effect)', () => {
    const onOpen = vi.fn()
    const h = mount({ onOpenFileInEditor: onOpen })
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    click(menu()[2])
    expect(h.client.gitDiffCalls).toHaveLength(0)
  })

  it('with no callback wired, the control is disabled rather than silently inert', () => {
    const h = mount({})
    h.status([file({ path: 'src/app.ts' })])
    click(q('[data-testid="changes-row-menu"]'))
    expect(menu()[2].disabled).toBe(true)
  })
})

describe('Changes pane — commit', () => {
  it('Commit is refused until something is staged AND a message is typed', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts' })])
    const commit = (): HTMLButtonElement => q<HTMLButtonElement>('[data-testid="changes-commit"]')!
    expect(commit().disabled).toBe(true)
    h.status([file({ path: 'a.ts', staged: true })])
    expect(commit().disabled).toBe(true)
  })

  it('Commit sends the trimmed message and the staged count is a distinct-path count', () => {
    const h = mount({})
    h.status([
      file({ path: 'a.ts', staged: true }),
      file({ path: 'a.ts', staged: false }),
      file({ path: 'b.ts', staged: true })
    ])
    expect(q('[data-testid="changes-staged-count"]')!.textContent).toBe('2 files staged')
    typeCommitMessage('  add a and b  ')
    click(q('[data-testid="changes-commit"]'))
    expect(h.client.gitCommitCalls).toEqual([{ dir: '/repo', message: 'add a and b' }])
  })

  it('a commit failure surfaces the daemon message instead of an idle button', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts', staged: true })])
    typeCommitMessage('msg')
    click(q('[data-testid="changes-commit"]'))
    act(() => h.client.emit({ type: 'error', message: 'git commit failed: nothing to commit' }))
    expect(q('[data-testid="changes-commit-error"]')!.textContent).toContain(
      'git commit failed: nothing to commit'
    )
    expect(q<HTMLButtonElement>('[data-testid="changes-commit"]')!.disabled).toBe(false)
  })

  it('Commit & push pushes only after the commit lands', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts', staged: true })])
    typeCommitMessage('msg')
    click(q('[data-testid="changes-commit-options"]'))
    click(q('[data-testid="changes-commit-push"]'))
    expect(h.client.gitPushCalls).toHaveLength(0)
    act(() => h.client.emit({ type: 'git_commit', dir: '/repo', sha: 'abc1234', summary: 'msg' }))
    expect(h.client.gitPushCalls).toEqual(['/repo'])
  })
})

describe('Changes pane — the strip\'s bulk actions', () => {
  it('Stage all sends explicit paths and excludes blocked ones', () => {
    const h = mount({})
    h.status([
      file({ path: 'src/app.ts' }),
      file({ path: '.env', is_sensitive: true }),
      file({ path: 'src/other.ts' })
    ])
    const btn = q<HTMLButtonElement>('[data-testid="changes-stage-all"]')!
    expect(btn.textContent).toBe('Stage all')
    expect(btn.disabled).toBe(false)
    click(btn)
    expect(h.client.gitStageCalls).toEqual([
      { dir: '/repo', paths: ['src/app.ts', 'src/other.ts'] }
    ])
  })

  it('an all-blocked set disables Stage all AND says why — never a no-op click', () => {
    const h = mount({})
    h.status([
      file({ path: '.env', is_sensitive: true }),
      file({ path: 'secrets.json', is_sensitive: true })
    ])
    const btn = q<HTMLButtonElement>('[data-testid="changes-stage-all"]')!
    expect(btn.disabled).toBe(true)
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain('blocked path')
    click(btn)
    expect(h.client.gitStageCalls).toHaveLength(0)
  })

  it('Unstage all takes only the staged side', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts', staged: true }), file({ path: 'b.ts', staged: false })])
    const btn = q<HTMLButtonElement>('[data-testid="changes-unstage-all"]')!
    expect(btn.textContent).toBe('Unstage all')
    click(btn)
    expect(h.client.gitUnstageCalls).toEqual([{ dir: '/repo', paths: ['a.ts'] }])
  })
})

describe('Changes pane — the group headers\' bulk actions', () => {
  it('each header stages or unstages only its own group', () => {
    const h = mount({})
    h.status([
      file({ path: 'a.ts', staged: true }),
      file({ path: 'b.ts', staged: false }),
      file({ path: 'c.ts', status: 'untracked' })
    ])
    const staged = q<HTMLButtonElement>('[data-testid="changes-bulk-staged"]')!
    const unstaged = q<HTMLButtonElement>('[data-testid="changes-bulk-unstaged"]')!
    const untracked = q<HTMLButtonElement>('[data-testid="changes-bulk-untracked"]')!
    expect(staged.textContent).toBe('Unstage all')
    expect(unstaged.textContent).toBe('Stage all')

    click(unstaged)
    expect(h.client.gitStageCalls).toEqual([{ dir: '/repo', paths: ['b.ts'] }])
    click(untracked)
    expect(h.client.gitStageCalls[1]).toEqual({ dir: '/repo', paths: ['c.ts'] })
    click(staged)
    expect(h.client.gitUnstageCalls).toEqual([{ dir: '/repo', paths: ['a.ts'] }])
  })

  it('an all-blocked group disables its header button — never sends an empty list', () => {
    const h = mount({})
    h.status([file({ path: '.env', is_sensitive: true })])
    const btn = q<HTMLButtonElement>('[data-testid="changes-bulk-unstaged"]')!
    expect(btn.disabled).toBe(true)
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain('blocked path')
    click(btn)
    expect(h.client.gitStageCalls).toHaveLength(0)
  })

  it('a partly-blocked group sends the visible paths only', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts' }), file({ path: '.env', is_sensitive: true })])
    click(q('[data-testid="changes-bulk-unstaged"]'))
    expect(h.client.gitStageCalls).toEqual([{ dir: '/repo', paths: ['a.ts'] }])
  })
})

describe('Changes pane — standalone Push', () => {
  it('pushes a branch that is ahead with nothing staged', () => {
    const h = mount({})
    h.status([], { ahead: 2 })
    const btn = q<HTMLButtonElement>('[data-testid="changes-push"]')!
    expect(btn.textContent).toContain('Push ↑2')
    expect(btn.disabled).toBe(false)
    click(btn)
    expect(h.client.gitPushCalls).toEqual(['/repo'])
  })

  it('is disabled and says why when there is nothing ahead', () => {
    const h = mount({})
    h.status([], { ahead: 0 })
    const btn = q<HTMLButtonElement>('[data-testid="changes-push"]')!
    expect(btn.disabled).toBe(true)
    expect(btn.closest('[data-tooltip]')?.getAttribute('data-tooltip')).toContain('Nothing to push')
    click(btn)
    expect(h.client.gitPushCalls).toHaveLength(0)
  })

  it('pushes a branch with no upstream, publishing it', () => {
    const h = mount({})
    h.status([], { ahead: 3, upstream: null })
    const btn = q<HTMLButtonElement>('[data-testid="changes-push"]')!
    expect(btn.disabled).toBe(false)
    click(btn)
    expect(h.client.gitPushCalls).toEqual(['/repo'])
  })

  it('a rejected push is reported, not swallowed', () => {
    const h = mount({})
    h.status([], { ahead: 1 })
    click(q('[data-testid="changes-push"]'))
    act(() =>
      h.client.emit({ type: 'error', message: 'failed to push some refs to origin' })
    )
    expect(q('[data-testid="changes-commit-error"]')?.textContent).toContain(
      'failed to push some refs'
    )
  })

  it('a push that rides on a commit reports its own failure too', () => {
    const h = mount({})
    h.status([file({ path: 'a.ts', staged: true })])
    typeCommitMessage('msg')
    click(q('[data-testid="changes-commit-options"]'))
    click(q('[data-testid="changes-commit-push"]'))
    act(() => h.client.emit({ type: 'git_commit', dir: '/repo', sha: 'abc1234', summary: 'msg' }))
    expect(h.client.gitPushCalls).toEqual(['/repo'])
    act(() => h.client.emit({ type: 'error', message: 'pre-push hook refused' }))
    expect(q('[data-testid="changes-commit-error"]')?.textContent).toContain(
      'pre-push hook refused'
    )
  })
})
