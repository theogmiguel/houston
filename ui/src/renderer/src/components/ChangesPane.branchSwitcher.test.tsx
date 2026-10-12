// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, click, file, mount, q, qa, teardown } from './ChangesPane.harness'

beforeEach(() => { localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000) })
afterEach(() => vi.restoreAllMocks())
afterEach(teardown)

function branch(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, current: false, is_default: false, is_remote: false, ...extra }
}

function open(): ReturnType<typeof mount> {
  const h = mount({ compact: true })
  h.status([file()], { branch: 'topic', ahead: 2 })
  click(q('[data-testid="changes-branch-chip"]'))
  act(() => h.client.emit({ type: 'git_branches', dir: '/repo', branches: [
    branch('topic', { current: true, committed_at: 1_800_000_000 - 3600 }),
    branch('old', { committed_at: 1_800_000_000 - 10800, behind: 2 }),
    branch('main', { is_default: true, committed_at: 1_800_000_000 - 14400 }),
    branch('recent', { committed_at: 1_800_000_000 - 7200, ahead: 3 })
  ], remotes: [], default_branch: 'main', truncated: false }))
  return h
}

function typeName(value: string): HTMLInputElement {
  const input = q<HTMLInputElement>('[aria-label="Find or create a branch"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return input
}

function key(input: Element, key: string, ctrlKey = false): void {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true })))
}

describe('Changes branch switcher', () => {
  it('keeps a compact Esc HintKey inside one field with one focus halo', () => {
    open()
    const input = q<HTMLInputElement>('[aria-label="Find or create a branch"]')!
    const field = input.parentElement!
    const hint = field.querySelector('kbd')!
    expect(hint?.textContent).toBe('Esc')
    expect(hint?.className).toContain('flex-none')
    expect(hint?.className.split(' ')).not.toContain('border')
    expect(field.className).toContain('focus-within:shadow-')
    expect(field.className).not.toContain('focus-within:ring-')
    expect(input.className).not.toContain('focus-visible:ring-')
    expect(input.className).toContain('focus-visible:outline-0')
  })

  it('labels worktree rows in words while preserving sync metadata', () => {
    const h = open()
    act(() => h.client.emit({ type: 'git_branches', dir: '/repo', branches: [
      branch('topic', { current: true }),
      branch('tree', { worktree_path: '/other/tree', ahead: 1, behind: 2, committed_at: 1_800_000_000 - 10800 })
    ], remotes: [], default_branch: 'main', truncated: false }))
    const row = qa('[role="dialog"] [role="option"]')[1]
    expect(row.textContent).toBe('treeworktree · tree · 1 ahead · 2 behind · 3h')
    click(row)
    expect(h.client.createSessionCalls).toEqual([{ agent: 'shell', project_dir: '/other/tree' }])
  })

  it('renders Manage as a muted link, not the accent link', () => {
    open()
    const manage = qa('[role="dialog"] button').find((item) => item.textContent === 'Manage…')!
    expect(manage.className).toContain('text-[var(--text-muted)]')
    expect(manage.className).not.toContain('text-[var(--accent)]')
  })

  it('pins current then orders recent commits with sync and age metadata', () => {
    open()
    const options = qa('[role="dialog"] [role="option"]')
    expect(options.map((item) => item.textContent)).toEqual(['topic1h', 'recent3 ahead · 2h', 'old2 behind · 3h', 'maindefault · 4h'])
    expect(options.filter((item) => item.getAttribute('aria-selected') === 'true')).toHaveLength(1)
    expect(q('[data-testid="changes-push"]')?.textContent).toBe('Push 2 commits')
  })

  it('arrow keys move one active row and Enter switches it', () => {
    const h = open()
    const input = q<HTMLInputElement>('[aria-label="Find or create a branch"]')!
    key(input, 'ArrowDown')
    key(input, 'ArrowDown')
    key(input, 'ArrowUp')
    const active = qa('[role="dialog"] [aria-selected="true"]')
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toBe('recent3 ahead · 2h')
    key(input, 'Enter')
    expect(h.client.gitBranchSwitchCalls).toEqual([{ dir: '/repo', name: 'recent' }])
  })

  it('searches, keeps one active row, and switches with Enter', () => {
    const h = open()
    const input = typeName('main')
    expect(qa('[role="dialog"] [role="option"]')).toHaveLength(1)
    key(input, 'ArrowDown')
    expect(input.getAttribute('aria-activedescendant')).toBe(q('[role="dialog"] [role="option"]')?.id)
    key(input, 'Enter')
    expect(h.client.gitBranchSwitchCalls).toEqual([{ dir: '/repo', name: 'main' }])
    expect(q('[aria-label="Switch or create a branch"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="changes-branch-chip"]'))
  })

  it('Enter creates the named branch from the default base and switches to it', () => {
    const h = open()
    const input = typeName('feat/new')
    expect(qa('[role="dialog"] [aria-selected="true"]')).toHaveLength(1)
    expect(q('[role="dialog"] [role="option"]')?.textContent).toBe('Branch feat/new from mainEnter')
    key(input, 'Enter')
    expect(h.client.gitBranchCreateCalls).toEqual([{ dir: '/repo', name: 'feat/new', base: 'main', switchTo: true }])
  })

  it('Ctrl+Enter creates a worktree and opens one shell pane only after its receipt', () => {
    const h = open()
    const input = typeName('feat/tree')
    expect(q('[role="dialog"]')?.textContent?.replace(/\u00a0/g, ' ')).toContain('Worktree houston/feat-tree in a new pane')
    expect(q('[role="dialog"] strong.truncate')?.textContent).toBe('houston/feat-tree')
    key(input, 'Enter', true)
    expect(h.client.gitWorktreeCreateCalls).toEqual([{ dir: '/repo', name: 'feat-tree', base: 'main' }])
    expect(h.client.createSessionCalls).toHaveLength(0)
    act(() => h.client.emit({ type: 'git_worktrees', dir: '/other', worktrees: [{ branch: 'feat/tree', path: '/wrong' }] }))
    expect(h.client.createSessionCalls).toHaveLength(0)
    const receipt = { type: 'git_worktrees', dir: '/repo', worktrees: [{ branch: 'houston/feat-tree', path: '/state/worktrees/repo/feat-tree', is_main: false, is_detached: false, is_bare: false, dirty: false }], message: 'Created worktree' }
    act(() => h.client.emit(receipt))
    act(() => h.client.emit(receipt))
    expect(h.client.createSessionCalls).toEqual([{ agent: 'shell', project_dir: '/state/worktrees/repo/feat-tree' }])
  })

  it('a worktree refusal prevents a later broadcast from opening a pane', () => {
    const h = open()
    key(typeName('feat/tree'), 'Enter', true)
    act(() => h.client.emit({ type: 'error', message: 'git worktree add failed: branch feat/tree already exists' }))
    expect(q('[data-testid="changes-tools-error"]')?.textContent).toContain('feat/tree')
    act(() => h.client.emit({ type: 'git_worktrees', dir: '/repo', worktrees: [{ branch: 'feat/tree', path: '/existing' }] }))
    expect(h.client.createSessionCalls).toHaveLength(0)
  })

  it('Escape dismisses and restores focus without switching', () => {
    const h = open()
    key(typeName('main'), 'Escape')
    expect(h.client.gitBranchSwitchCalls).toHaveLength(0)
    expect(q('[aria-label="Switch or create a branch"]')).toBeNull()
    expect(document.activeElement).toBe(q('[data-testid="changes-branch-chip"]'))
  })
})
